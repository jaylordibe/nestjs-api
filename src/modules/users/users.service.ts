import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, User } from '@prisma/client';
import { packRules } from '@casl/ability/extra';
import type { AppAbility } from '../../common/authorization/app-ability';
import * as bcrypt from 'bcrypt';
import { buildOrderBy, MetaQueryDto } from '../../common/dto/meta-query.dto';
import { PaginationMeta } from '../../common/dto/paginated-response.dto';
import { AuditService } from '../../common/audit/audit.service';
import { Errors } from '../../common/errors/errors';
import { EmailService } from '../../common/email/email.service';
import { SmsService } from '../../common/sms/sms.service';
import { BusinessMembershipStatus } from '../../common/enums/business-membership-status.enum';
import { OtpPurpose } from '../../common/enums/otp-purpose.enum';
import {
  BCRYPT_ROUNDS,
  hashPassword,
} from '../../common/util/password-hashing.util';
import { RedisService } from '../../common/redis/redis.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { PermissionLoaderService } from '../authorization/permission-loader.service';
import { BusinessOwnershipPolicy } from '../businesses/business-ownership.policy';
import { CreateUserDto } from './dto/create-user.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateAuthUserEmailDto } from './dto/update-auth-user-email.dto';
import { UpdateAuthUserInfoDto } from './dto/update-auth-user-info.dto';
import { UpdateAuthUserPasswordDto } from './dto/update-auth-user-password.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserPermissionsResponseDto } from './dto/user-permissions-response.dto';
import { VerifyAuthUserPhoneDto } from './dto/verify-auth-user-phone.dto';

// OWASP 2024+ guidance. Bumping this is safe — existing hashes already
// encode their own cost factor and continue to verify correctly.
// One duplicate-signup notice per email address per 24h.
//
// Answering a signup collision with a uniform 201 closes the enumeration
// leak, but the notice email it depends on would otherwise turn the endpoint
// into an email-bombing amplifier: resubmit a victim's address in a loop and
// we deliver the mail. The global throttle bounds requests per IP; this
// bounds mail per RECIPIENT, which is the thing being abused, and survives an
// attacker rotating IPs. A genuine "I forgot I had an account" user needs
// exactly one of these per attempt anyway.
const DUPLICATE_SIGNUP_NOTICE_COOLDOWN_SECONDS = 24 * 60 * 60;
const DUPLICATE_SIGNUP_NOTICE_KEY_PREFIX = 'duplicate-signup-notice:';

const OTP_EXPIRY_MS = 15 * 60 * 1000;

function generateOtp(): string {
  // 6 digits, zero-padded. Brute-force risk is bounded by the 15-min expiry
  // window and the global throttle on verify/reset endpoints.
  const sixDigitValue = Math.floor(Math.random() * 1_000_000);
  return sixDigitValue.toString().padStart(6, '0');
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly smsService: SmsService,
    private readonly auditService: AuditService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly redis: RedisService,
    // `forwardRef` on both sides: AuthModule imports UsersModule for the login
    // path, and UsersModule needs session revocation back. Per CLAUDE.md, the
    // ref goes in the module imports AND on the injection.
    @Inject(forwardRef(() => RefreshTokenService))
    private readonly refreshTokenService: RefreshTokenService,
    private readonly permissionLoaderService: PermissionLoaderService,
    // The ownership invariant is enforced from BOTH sides. Deleting an account
    // is the other half of "a live business always has an active owner", and it
    // is the half that used to be missing entirely.
    private readonly businessOwnershipPolicy: BusinessOwnershipPolicy,
  ) {}

  // Tells the owner of an existing account that someone tried to sign up with
  // their email, and reports whether the mail actually went out.
  //
  // Returns false (without sending) when:
  //   • the account is soft-deleted — there is no live account to sign in to;
  //   • the 24h per-recipient cooldown is already claimed;
  //   • the provider fails — the caller's response must not change shape
  //     because our mail provider is down.
  // The caller audits the returned flag, so a suppressed send is visible in
  // `audit_logs` rather than silently absent.
  async sendDuplicateSignupNotice(existingUser: User): Promise<boolean> {
    if (existingUser.deletedAt) {
      return false;
    }
    // SET NX EX — atomic claim-the-window. Two concurrent attempts on the
    // same address can't both pass, which a GET-then-SET would allow.
    const claimedCooldown = await this.redis.client.set(
      `${DUPLICATE_SIGNUP_NOTICE_KEY_PREFIX}${existingUser.email}`,
      '1',
      'EX',
      DUPLICATE_SIGNUP_NOTICE_COOLDOWN_SECONDS,
      'NX',
    );
    if (claimedCooldown !== 'OK') {
      return false;
    }
    try {
      await this.emailService.sendDuplicateSignupAttemptNotification(
        existingUser.email,
        existingUser.firstName,
        this.configService.getOrThrow<string>('webBaseUrl'),
        new Date(),
      );
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        `Duplicate-signup notice failed for user ${existingUser.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  // JWT-based email verification link. Payload carries the user id and a
  // `purpose` claim that prevents the token being used as an access token
  // (JwtStrategy rejects any payload with `purpose` set). 24h expiry is
  // longer than the OTP window because email links sit in inboxes.
  async sendEmailVerificationLink(user: User): Promise<void> {
    if (user.deletedAt) {
      // Shouldn't happen in the register path, but guards against callers
      // later using this helper for soft-deleted users.
      return;
    }
    if (user.emailVerifiedAt) {
      // Idempotent: re-sending for an already-verified user is a no-op,
      // not an error. Lets the /auth/resend-verification endpoint be
      // abuse-safe (always 200).
      return;
    }
    const token = this.jwtService.sign(
      { sub: user.id, purpose: 'email_verify' },
      { expiresIn: '24h' },
    );
    const baseUrl = this.configService.getOrThrow<string>('apiBaseUrl');
    const verifyUrl = `${baseUrl}/auth/verify-email?token=${encodeURIComponent(token)}`;
    await this.emailService.sendEmailVerificationLink(
      user.email,
      user.firstName,
      verifyUrl,
    );
  }

  // Best-effort password-change notification. Called from every mutation
  // path that changes an existing user's password (self, admin-reset,
  // password-reset-via-OTP, admin PATCH with a password field). NOT
  // called from create/register (no prior password to worry about) or
  // gdprErase (anonymization; the user is the actor and the email
  // destination is already being nullified). Email failure never blocks
  // the password change — password changes must succeed even if the
  // provider is down; the audit log still captures the event.
  private async notifyPasswordChanged(user: User): Promise<void> {
    try {
      await this.emailService.sendPasswordChangedNotification(
        user.email,
        user.firstName,
        new Date(),
      );
    } catch (error) {
      this.logger.warn(
        `Failed to send password-change notification to ${user.email}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // Consume a verification JWT. Silent no-op for already-verified users
  // (idempotent). Any other failure — bad signature, wrong purpose,
  // expired, unknown user — surfaces as a generic 400 so an attacker
  // poking at the endpoint can't distinguish failure modes.
  async verifyEmailByToken(token: string): Promise<void> {
    interface VerifyPayload {
      sub?: unknown;
      purpose?: unknown;
    }
    let payload: VerifyPayload;
    try {
      payload = this.jwtService.verify<VerifyPayload>(token);
    } catch {
      throw Errors.invalidLink();
    }
    if (payload.purpose !== 'email_verify' || typeof payload.sub !== 'string') {
      throw Errors.invalidLink();
    }
    const user = await this.findByIdOrNull(payload.sub);
    if (!user) {
      throw Errors.invalidLink();
    }
    if (user.emailVerifiedAt) {
      return;
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date(), updatedBy: user.id },
    });
    await this.auditService.record({
      action: 'user.email_verified',
      actorId: user.id,
      targetUserId: user.id,
    });
  }

  async create(dto: CreateUserDto, actorId: string | null): Promise<User> {
    const passwordHash = await hashPassword(dto.password);
    // A single INSERT. No role is assigned, and no transaction is needed to
    // make one atomic with the user row.
    //
    // Self-service capability comes from AUTHENTICATED_USER_PERMISSIONS, which
    // `AbilityFactory` grants to every authenticated caller, so an account with
    // no roles is complete and working. Attaching a default role here instead
    // would make the user row and that row a single unit that must not be
    // half-written — a class of bug this design does not have rather than
    // guards against.
    const user = await this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase(),
        username: dto.username?.toLowerCase(),
        password: passwordHash,
        passwordChangedAt: new Date(),
        firstName: dto.firstName,
        middleName: dto.middleName,
        lastName: dto.lastName,
        phoneNumber: dto.phoneNumber,
        gender: dto.gender,
        birthday: dto.birthday,
        timezone: dto.timezone,
        profileImageUrl: dto.profileImageUrl,
        createdBy: actorId,
        updatedBy: actorId,
      },
    });

    // Only audit admin-initiated creates; self-signup has no actor.
    if (actorId) {
      await this.auditService.record({
        action: 'user.created.by_admin',
        actorId,
        targetUserId: user.id,
        metadata: { email: user.email },
      });
    }
    return user;
  }

  /**
   * The caller's own authorization, as packed CASL rules plus the role names
   * behind them. Consumed by `GET /users/me/permissions` so a client can
   * evaluate `can(...)` locally and reach the same verdict the server will.
   */
  async getOwnPermissions(
    userId: string,
    ability: AppAbility,
  ): Promise<UserPermissionsResponseDto> {
    const user = await this.prisma.scoped.user.findUnique({
      where: { id: userId },
      select: {
        userRoles: { select: { role: { select: { name: true } } } },
        // Every status, not only ACTIVE. A client showing "your businesses"
        // needs to render a suspended or pending membership differently rather
        // than have it silently vanish — and `rules` above already reflects the
        // truth about authority, since only ACTIVE memberships compile into
        // grants. This list is context, not permission.
        memberships: {
          select: {
            id: true,
            businessId: true,
            status: true,
            role: { select: { name: true } },
          },
        },
      },
    });

    return new UserPermissionsResponseDto({
      // `packRules` compresses each rule to a positional tuple. The client
      // restores it with `unpackRules` — the shape is CASL's, not ours.
      rules: packRules(ability.rules),
      platformRoles: (user?.userRoles ?? []).map(
        (userRole) => userRole.role.name,
      ),
      businessMemberships: (user?.memberships ?? []).map((membership) => ({
        membershipId: membership.id,
        businessId: membership.businessId,
        roleName: membership.role.name,
        status: membership.status as BusinessMembershipStatus,
      })),
    });
  }

  async findPaginated(
    query: MetaQueryDto,
  ): Promise<{ data: User[]; meta: PaginationMeta }> {
    const { page, perPage } = query;
    const args = this.buildListArgs(query);
    const [data, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        ...args,
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.user.count(),
    ]);
    return {
      data,
      meta: {
        page,
        perPage,
        total,
        totalPages: Math.ceil(total / perPage),
      },
    };
  }

  // Single source of truth for findPaginated's sort allowlist and default
  // ordering. Pass-through for the buildOrderBy() 400 on disallowed sortBy.
  // Extend this with a `where` clause built from `query.search` when adding
  // search to a resource.
  private buildListArgs(query: MetaQueryDto): {
    orderBy: Prisma.UserOrderByWithRelationInput;
  } {
    return {
      orderBy: buildOrderBy(
        query,
        ['email', 'firstName', 'lastName', 'createdAt', 'updatedAt'] as const,
        'createdAt',
      ),
    };
  }

  // Admin-facing fetch — uses the raw client so admins can see soft-
  // deleted rows for recovery/audit. Paths that must reject deleted users
  // (auth, login, JwtStrategy) use findByIdOrNull / findByEmail, which go
  // through the scoped client.
  async findById(id: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw Errors.resourceNotFound('User');
    }
    return user;
  }

  // Returns null for soft-deleted users — the scoped client filters
  // deletedAt: null automatically. Callers that need to see deleted rows
  // (admin recovery paths) should go through `findById` or directly hit
  // `prisma.user.*` instead.
  findByIdOrNull(id: string): Promise<User | null> {
    return this.prisma.scoped.user.findUnique({ where: { id } });
  }

  // `findFirst`, not `findUnique`: `email` is unique only among live rows (a
  // partial index), and Prisma cannot see a partial index — so `email` is not a
  // unique selector and `findUnique` would not type-check. The scoped client
  // filters `deletedAt: null`, which is exactly the set the partial index makes
  // unique, so `findFirst` returns at most one row.
  findByEmail(email: string): Promise<User | null> {
    return this.prisma.scoped.user.findFirst({
      where: { email: email.toLowerCase() },
    });
  }

  // Login lookup: the identifier may be an email or a username (both stored
  // lowercase; usernames can never contain '@' so the namespaces are
  // disjoint). Scoped client — soft-deleted users come back null, identical
  // to "unknown identifier".
  findByEmailOrUsername(identifier: string): Promise<User | null> {
    const normalized = identifier.toLowerCase();
    return this.prisma.scoped.user.findFirst({
      where: { OR: [{ email: normalized }, { username: normalized }] },
    });
  }

  async update(
    id: string,
    dto: UpdateUserDto,
    actorId: string | null,
  ): Promise<User> {
    const existing = await this.findById(id);

    const updateData: Prisma.UserUpdateInput = {
      email: dto.email?.toLowerCase(),
      username: dto.username?.toLowerCase(),
      firstName: dto.firstName,
      middleName: dto.middleName,
      lastName: dto.lastName,
      phoneNumber: dto.phoneNumber,
      gender: dto.gender,
      birthday: dto.birthday,
      timezone: dto.timezone,
      profileImageUrl: dto.profileImageUrl,
      isActive: dto.isActive,
      updatedBy: actorId,
    };

    // Deactivation is not an ordinary field write. An inactive account cannot
    // authenticate — `JwtStrategy` refuses it on every request — so a business
    // whose only owner is deactivated is exactly as unadministrable as one whose
    // owner was deleted, and it needs the same refusal. It also has to end the
    // account's sessions: leaving live refresh rows behind means a later
    // reactivation silently resurrects every session that existed before.
    const updated =
      dto.isActive === false && existing.isActive
        ? await this.deactivate(id, updateData, actorId)
        : await this.prisma.user.update({ where: { id }, data: updateData });

    if (actorId && actorId !== id) {
      await this.auditService.record({
        action: 'user.updated.by_admin',
        actorId,
        targetUserId: id,
        metadata: {
          // Role changes no longer travel through this endpoint — they have
          // their own audited routes (`POST/DELETE /users/:userId/roles`).
          isActiveChanged: dto.isActive !== undefined,
        },
      });
    }
    return updated;
  }

  /**
   * Active → inactive, with the ownership invariant and the session end that a
   * bare field write would skip.
   *
   * Refused when the account is somebody's last owner. A platform admin is not
   * exempt: `manage all` bypasses AUTHORIZATION, not data integrity, and the
   * unadministrable business it would leave behind is invisible to every roster
   * read — so nobody would find it to repair it.
   */
  private async deactivate(
    userId: string,
    updateData: Prisma.UserUpdateInput,
    actorId: string | null,
  ): Promise<User> {
    const deactivated = await this.prisma.$transaction(async (transaction) => {
      // User row first, then businesses — the order in `row-lock.util.ts`.
      await this.refreshTokenService.lockSessions(transaction, userId);
      await this.businessOwnershipPolicy.assertUserIsNotASoleOwner(
        transaction,
        userId,
      );
      return this.refreshTokenService.endAllSessionsInTransaction(
        transaction,
        userId,
        actorId,
        updateData,
      );
    });
    // Their business-scoped grants are gone the instant the row says inactive.
    await this.invalidateGrantsFor([userId]);
    return deactivated;
  }

  async remove(id: string, actorId: string | null): Promise<void> {
    await this.findById(id);
    // Admin "delete" is soft — keeps the row for audit trail / recovery.
    // For true PII removal (GDPR right-to-be-forgotten) the user themselves
    // invokes gdprErase, which also anonymizes personal columns.
    //
    // Refused outright when the target is somebody's last owner. A platform
    // admin is not exempt: `manage all` bypasses AUTHORIZATION, not data
    // integrity, and the stranded membership it would create is invisible to
    // every roster read — so nobody would find it to repair it.
    await this.deleteAccount(id, actorId);
    if (actorId) {
      await this.auditService.record({
        action: 'user.soft_deleted.by_admin',
        actorId,
        targetUserId: id,
      });
    }
  }

  // Right-to-be-forgotten path. Overwrites every column that could identify
  // the user (email, name, phone, etc.) with sentinel values, wipes the
  // password so no bcrypt hash survives, and marks deletedAt. The row
  // itself stays so FK'd records (audit logs, bookings, etc.) remain
  // queryable — but none of it points back to a real human.
  async gdprErase(userId: string, currentPassword: string): Promise<void> {
    const user = await this.findById(userId);
    const passwordMatches = await bcrypt.compare(
      currentPassword,
      user.password,
    );
    if (!passwordMatches) {
      throw Errors.currentPasswordIncorrect();
    }
    const now = new Date();
    const erasedPasswordHash = await hashPassword(
      `erased-${userId}-${now.getTime()}`,
    );

    // Erasure does NOT refuse on sole ownership, and that asymmetry with
    // `softDelete` is the whole point: a right-to-be-forgotten request answers a
    // legal obligation, so it cannot be declined because of a commercial
    // relationship. The businesses are closed in the same transaction instead —
    // never left ownerless, never left live.
    const { businesses: closedBusinesses, affectedUserIds } =
      await this.prisma.$transaction(async (transaction) => {
        // User row first, then the businesses — the order documented in
        // `row-lock.util.ts`. Taking the businesses first (as this used to) is
        // the opposite of what every membership mutation takes, so the two sides
        // of the ownership invariant could deadlock against each other.
        await this.refreshTokenService.lockSessions(transaction, userId);
        const closed =
          await this.businessOwnershipPolicy.closeSolelyOwnedBusinesses(
            transaction,
            userId,
            userId,
          );

        // The anonymisation rides INSIDE the session-ending mutation, so the
        // erased row and the dead sessions are one row version. There is no
        // ordering in which the account is wiped but its sessions still work.
        await this.refreshTokenService.endAllSessionsInTransaction(
          transaction,
          userId,
          userId,
          {
            email: `deleted-${userId}@deleted.invalid`,
            username: null,
            password: erasedPasswordHash,
            firstName: 'Deleted',
            middleName: null,
            lastName: 'User',
            phoneNumber: null,
            gender: null,
            birthday: null,
            timezone: null,
            profileImageUrl: null,
            otpHash: null,
            otpPurpose: null,
            otpExpiresAt: null,
            emailVerifiedAt: null,
            deletedAt: now,
            deletedBy: userId,
          },
        );
        return closed;
      });

    // Cache invalidation happens AFTER the commit. Dropping a cached grant set
    // while the transaction could still roll back would repopulate it from the
    // pre-erasure rows and leave the stale copy behind — the one failure mode
    // an invalidation is supposed to rule out.
    await this.invalidateGrantsFor([userId, ...affectedUserIds]);

    await this.auditService.record({
      action: 'user.gdpr_erased',
      actorId: userId,
      targetUserId: userId,
      // Ids only. The business NAMES are personal data in a single-proprietor
      // tenant, and writing them into the audit trail during an erasure would
      // re-create exactly what the erasure just removed.
      metadata: {
        closedBusinessIds: closedBusinesses.map((business) => business.id),
      },
    });
  }

  /**
   * Soft-delete an account, refusing to strand a business without an owner.
   *
   * Shared by the administrative delete and the self-close so the invariant
   * cannot hold on one route and not the other — they differ only in who acts
   * and which audit event follows, never in what is allowed.
   */
  private async deleteAccount(
    userId: string,
    actorId: string | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      // User row first, then businesses — see `row-lock.util.ts`. This is also
      // what makes the check below binding: a promotion racing this deletion
      // contends on the SAME user row, so it either loses and finds the account
      // gone, or wins and is counted here.
      await this.refreshTokenService.lockSessions(transaction, userId);
      await this.businessOwnershipPolicy.assertUserIsNotASoleOwner(
        transaction,
        userId,
      );
      // A deleted account must not keep minting access tokens off a refresh
      // token. `JwtStrategy` already rejects the user through the scoped
      // client, but leaving live rows behind means a restore silently
      // resurrects every session that existed before the deletion.
      await this.refreshTokenService.endAllSessionsInTransaction(
        transaction,
        userId,
        actorId,
        { deletedAt: new Date(), deletedBy: actorId },
      );
    });
    await this.invalidateGrantsFor([userId]);
  }

  /** Drop cached grant sets, one user at a time, tolerating a cache outage. */
  private async invalidateGrantsFor(userIds: readonly string[]): Promise<void> {
    for (const userId of new Set(userIds)) {
      await this.permissionLoaderService.invalidateUser(userId);
    }
  }

  async updateInfo(
    userId: string,
    dto: UpdateAuthUserInfoDto,
    actorId: string,
  ): Promise<User> {
    await this.findById(userId);
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        firstName: dto.firstName,
        middleName: dto.middleName,
        lastName: dto.lastName,
        phoneNumber: dto.phoneNumber,
        gender: dto.gender,
        birthday: dto.birthday,
        timezone: dto.timezone,
        updatedBy: actorId,
      },
    });
  }

  async softDelete(userId: string, actorId: string): Promise<void> {
    await this.findById(userId);
    // Self-close: mark the row deleted. The scoped Prisma client and the
    // auth hot paths both reject rows with deletedAt set, so the user
    // can't log back in. `isActive` is untouched — that flag exists for
    // suspension (a separate business concept from deletion), not to
    // double-signal lifecycle state. The row stays for audit/FK integrity;
    // call gdprErase for true PII removal.
    //
    // Refused while the user is the last active owner of a live business — the
    // response names them, and the remedy (transfer ownership, or delete the
    // business) is entirely in the caller's hands. `POST /users/me/gdpr-erase`
    // is the path that cannot be refused, and it closes those businesses
    // instead.
    await this.deleteAccount(userId, actorId);
    await this.auditService.record({
      action: 'user.self_deleted',
      actorId,
      targetUserId: userId,
    });
  }

  async updateUsername(
    userId: string,
    username: string,
    actorId: string,
  ): Promise<User> {
    await this.findById(userId);
    return this.prisma.user.update({
      where: { id: userId },
      data: { username: username.toLowerCase(), updatedBy: actorId },
    });
  }

  /**
   * Moves the account to a new address, and ends every session doing so.
   *
   * The address is the account's primary identifier and its recovery channel, so
   * changing it is a credential change in everything but name — which is why
   * `src/common/errors/README.md` has always listed "email changed" among the
   * triggers for `SESSION_INVALIDATED`. The code did not do it: the new address
   * was unverified (login refuses those) while every access token issued against
   * the OLD one kept working, so an attacker who had taken the account could
   * move it out of the owner's reach and keep their own session alive.
   */
  async updateEmail(
    userId: string,
    dto: UpdateAuthUserEmailDto,
    actorId: string,
  ): Promise<User> {
    const user = await this.findById(userId);
    const passwordMatches = await bcrypt.compare(
      dto.currentPassword,
      user.password,
    );
    if (!passwordMatches) {
      throw Errors.currentPasswordIncorrect();
    }
    return this.refreshTokenService.endAllSessions(userId, actorId, {
      email: dto.newEmail.toLowerCase(),
      emailVerifiedAt: null,
    });
  }

  /**
   * THE credential write. Every password change on an existing account goes
   * through here.
   *
   * Writes the hash, stamps `passwordChangedAt`, and revokes every refresh
   * family — all in one transaction, under the session lock.
   *
   * There is deliberately no parameter to skip the revocation. Hashing was
   * already centralized while the WRITE was not, and the result was that five of
   * six call sites remembered `passwordChangedAt` and forgot to end the
   * sessions: access tokens died, so the account holder believed the session was
   * closed, while a stolen refresh token kept exchanging and re-extending its
   * own expiry indefinitely. Making the revocation impossible to omit is the
   * fix; asking callers to remember it is what failed.
   *
   * `extraData` lets a caller fold in fields that must land atomically with the
   * credential change — clearing an OTP, anonymising a profile — without
   * reopening the chance to write a password some other way.
   */
  private async applyPasswordChange(
    userId: string,
    plaintextPassword: string,
    actorId: string | null,
    extraData: Prisma.UserUpdateInput = {},
  ): Promise<User> {
    // Hashed BEFORE the transaction opens. bcrypt at 12 rounds costs ~250ms, and
    // holding a row lock across it would serialise every concurrent session
    // operation on this account behind a deliberately slow function.
    const passwordHash = await hashPassword(plaintextPassword);

    return this.prisma.$transaction(async (transaction) => {
      // User lock first — the same order every session path uses, so a
      // credential change and a concurrent rotation cannot deadlock, and a
      // rotation in flight cannot slip a replacement token past the revocation.
      await this.refreshTokenService.lockSessions(transaction, userId);
      return this.refreshTokenService.endAllSessionsInTransaction(
        transaction,
        userId,
        actorId,
        { ...extraData, password: passwordHash },
      );
    });
  }

  async updateOwnPassword(
    userId: string,
    dto: UpdateAuthUserPasswordDto,
    actorId: string,
  ): Promise<User> {
    const user = await this.findById(userId);
    const passwordMatches = await bcrypt.compare(
      dto.currentPassword,
      user.password,
    );
    if (!passwordMatches) {
      throw Errors.currentPasswordIncorrect();
    }
    const updated = await this.applyPasswordChange(
      userId,
      dto.newPassword,
      actorId,
    );
    await this.notifyPasswordChanged(updated);
    return updated;
  }

  async updatePasswordAsAdmin(
    userId: string,
    newPassword: string,
    actorId: string,
  ): Promise<User> {
    if (userId === actorId) {
      throw Errors.adminSelfTargetForbidden(
        'Use /users/me/password to change your own password',
      );
    }
    await this.findById(userId);
    const updated = await this.applyPasswordChange(
      userId,
      newPassword,
      actorId,
    );
    await this.auditService.record({
      action: 'password.reset.by_admin',
      actorId,
      targetUserId: userId,
    });
    await this.notifyPasswordChanged(updated);
    return updated;
  }

  async updateProfileImage(
    userId: string,
    profileImageUrl: string,
    actorId: string,
  ): Promise<User> {
    await this.findById(userId);
    return this.prisma.user.update({
      where: { id: userId },
      data: { profileImageUrl, updatedBy: actorId },
    });
  }

  // Step 1 of phone update: verify the password (the kickoff is gated on
  // a fresh password proof so a stolen JWT alone can't redirect the
  // user's phone number to attacker-controlled), then generate an OTP,
  // store its hash, and dispatch it to the *new* phone number. The hash
  // binds the code to the target number (`otp:phoneNumber`) so a code
  // delivered to phone X cannot later be replayed to claim phone Y on
  // the verify step. Re-issuing replaces any existing PHONE_VERIFY OTP —
  // the latest request wins.
  async requestPhoneVerification(
    userId: string,
    currentPassword: string,
    phoneNumber: string,
  ): Promise<void> {
    const user = await this.findById(userId);
    const passwordMatches = await bcrypt.compare(
      currentPassword,
      user.password,
    );
    if (!passwordMatches) {
      throw Errors.currentPasswordIncorrect();
    }
    const otp = generateOtp();
    const otpHash = await bcrypt.hash(`${otp}:${phoneNumber}`, BCRYPT_ROUNDS);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        otpHash,
        otpPurpose: OtpPurpose.PHONE_VERIFY,
        otpExpiresAt: new Date(Date.now() + OTP_EXPIRY_MS),
      },
    });
    await this.smsService.sendPhoneVerificationOtp(phoneNumber, otp);
  }

  // Step 2 of the verified-phone flow: verify the OTP against the *same*
  // phone number it was issued for, then apply it. Same opaque error on
  // every failure so callers can't distinguish "wrong code" from "expired"
  // from "wrong number". Clears the OTP triple on success — a code is
  // single-use.
  async verifyAndUpdatePhoneNumber(
    userId: string,
    dto: VerifyAuthUserPhoneDto,
    actorId: string,
  ): Promise<User> {
    const user = await this.findById(userId);
    if (
      !user.otpHash ||
      user.otpPurpose !== OtpPurpose.PHONE_VERIFY ||
      !user.otpExpiresAt ||
      user.otpExpiresAt.getTime() < Date.now()
    ) {
      throw Errors.invalidOtp();
    }
    const matches = await bcrypt.compare(
      `${dto.otp}:${dto.phoneNumber}`,
      user.otpHash,
    );
    if (!matches) {
      throw Errors.invalidOtp();
    }
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        phoneNumber: dto.phoneNumber,
        // Stamp verification at the moment the OTP is accepted —
        // mirrors `emailVerifiedAt` after a successful email-link
        // confirm. Re-running the OTP flow with the same number
        // re-stamps to a fresh `now`, which is fine: the field is
        // semantically "last verified at," not "first verified at."
        phoneNumberVerifiedAt: new Date(),
        otpHash: null,
        otpPurpose: null,
        otpExpiresAt: null,
        updatedBy: actorId,
      },
    });
  }

  // Plain phone update without verification. Used by `PATCH /users/me/phone`.
  // Always clears `phoneNumberVerifiedAt` — the new number hasn't been
  // proven owned, so any prior verified state on the row is no longer
  // meaningful. Callers that need a verified number should run the OTP
  // flow (`requestPhoneVerification` → `verifyAndUpdatePhoneNumber`).
  async updatePhoneNumber(
    userId: string,
    phoneNumber: string,
    actorId: string,
  ): Promise<User> {
    await this.findById(userId);
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        phoneNumber,
        phoneNumberVerifiedAt: null,
        updatedBy: actorId,
      },
    });
  }

  // Public entry point for "resend my verification email". Accepts email
  // rather than userId so unverified users (who can't log in) can call
  // it without authenticating. Silent no-op if the email isn't
  // registered or is already verified — keeps the response opaque.
  async resendEmailVerification(email: string): Promise<void> {
    const user = await this.findByEmail(email);
    if (!user || user.deletedAt || user.emailVerifiedAt) {
      return;
    }
    await this.sendEmailVerificationLink(user);
  }

  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.findByEmail(email);
    // Intentionally no error when the email isn't registered — the caller
    // (controller) returns 200 regardless, so the attacker can't enumerate
    // registered emails through this endpoint.
    if (!user || !user.isActive) {
      return;
    }
    const otp = generateOtp();
    const otpHash = await bcrypt.hash(otp, BCRYPT_ROUNDS);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        otpHash,
        otpPurpose: OtpPurpose.PASSWORD_RESET,
        otpExpiresAt: new Date(Date.now() + OTP_EXPIRY_MS),
      },
    });
    await this.emailService.sendPasswordResetOtp(user.email, otp);
  }

  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const user = await this.findByEmail(dto.email);
    if (
      !user ||
      !user.isActive ||
      !user.otpHash ||
      user.otpPurpose !== OtpPurpose.PASSWORD_RESET ||
      !user.otpExpiresAt ||
      user.otpExpiresAt.getTime() < Date.now()
    ) {
      // Same opaque error for every failure mode so an attacker can't
      // distinguish "wrong email" from "expired OTP" from "wrong code".
      throw Errors.invalidOtp();
    }
    const otpMatches = await bcrypt.compare(dto.otp, user.otpHash);
    if (!otpMatches) {
      throw Errors.invalidOtp();
    }
    const updated = await this.applyPasswordChange(
      user.id,
      dto.newPassword,
      user.id,
      {
        // Folded into the same transaction: a reset that cleared the OTP but
        // failed to write the password would burn the code for nothing.
        otpHash: null,
        otpPurpose: null,
        otpExpiresAt: null,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    );
    await this.auditService.record({
      action: 'password.reset.completed',
      actorId: user.id,
      targetUserId: user.id,
    });
    await this.notifyPasswordChanged(updated);
  }

  // ── Support operations ─────────────────────────────────────────────────
  //
  // Three narrow capabilities held by PLATFORM_APP_SUPPORT, deliberately NOT
  // expressed as slices of `update User`. The difference is the whole design:
  // unlocking an account or re-sending its verification link HELPS its owner,
  // whereas changing its email TAKES it from them. Granting support the ability
  // to edit an arbitrary user is account takeover wearing a helpful hat, so
  // each of these is its own permission and none of them can write a field.

  /**
   * Clears a failed-login lockout.
   *
   * Deliberately does NOT touch the password, the email, or any session — an
   * account is unlocked exactly as its owner left it. `findByIdOrThrow` keeps
   * the 404 behaviour consistent with every other admin route.
   */
  async unlock(userId: string, actorId: string): Promise<User> {
    const user = await this.findById(userId);
    const unlocked = await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, updatedBy: actorId },
    });
    await this.auditService.record({
      action: 'user.unlocked_by_support',
      actorId,
      targetUserId: user.id,
      metadata: { previousFailedLoginCount: user.failedLoginCount },
    });
    return unlocked;
  }

  /**
   * Ends every session the account holds, on every device.
   *
   * Moves the session cutoff as well as revoking the refresh chains, so access
   * tokens die too. Revoking the chains alone was very nearly a no-op against
   * the attacker this exists for: `jwt.expiresIn` is 30 days in this template,
   * so "we have revoked their sessions" left a stolen access token working for
   * up to a month. The old docstring called that window "inherent … which is why
   * they are short-lived"; the reasoning is sound and the premise was false.
   */
  async revokeAllSessions(userId: string, actorId: string): Promise<void> {
    const user = await this.findById(userId);
    await this.refreshTokenService.endAllSessions(user.id, actorId);
    await this.auditService.record({
      action: 'user.sessions_revoked_by_support',
      actorId,
      targetUserId: user.id,
    });
  }

  /**
   * Re-sends the email-verification link on a user's behalf.
   *
   * Distinct from the public `POST /auth/resend-verification`, which must stay
   * silent about whether an address is registered. This one is called by
   * authenticated staff who can already see the account, so it can 404 honestly
   * and report whether there was anything to send.
   */
  async resendVerificationForUser(
    userId: string,
    actorId: string,
  ): Promise<void> {
    const user = await this.findById(userId);
    if (user.emailVerifiedAt) {
      throw Errors.resourceConflict('That account is already verified');
    }
    await this.sendEmailVerificationLink(user);
    await this.auditService.record({
      action: 'user.verification_resent_by_support',
      actorId,
      targetUserId: user.id,
    });
  }
}
