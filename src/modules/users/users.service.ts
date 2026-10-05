import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, User } from '@prisma/client';
import { packRules } from '@casl/ability/extra';
import type { AppAbility } from '../../common/authorization/app-ability';
import * as bcrypt from 'bcrypt';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { buildOrderBy, MetaQueryDto } from '../../common/dto/meta-query.dto';
import { PaginationMeta } from '../../common/dto/paginated-response.dto';
import { AuditService } from '../../common/audit/audit.service';
import { Errors } from '../../common/errors/errors';
import { EmailService } from '../../common/email/email.service';
import { SmsService } from '../../common/sms/sms.service';
import type { DeliveryOutcome } from '../../common/send-limit/delivery-outcome';
import { DestinationSendLimitService } from '../../common/send-limit/destination-send-limit.service';
import { SendPurpose } from '../../common/send-limit/send-limit.config';
import { formatErrorMessage } from '../../common/util/error-message.util';
import { canonicalEmailDestination } from '../../common/util/message-destination.util';
import { WorkspaceMembershipStatus } from '../../common/enums/workspace-membership-status.enum';
import { OtpPurpose } from '../../common/enums/otp-purpose.enum';
import { JobName } from '../../common/queue/job-registry';
import { QueueProducerService } from '../../common/queue/queue-producer.service';
import {
  generateOpaqueToken,
  hashOpaqueToken,
} from '../../common/util/opaque-token.util';
import {
  BCRYPT_ROUNDS,
  hashPassword,
} from '../../common/util/password-hashing.util';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  RefreshTokenContext,
  SessionTokens,
} from '../auth/refresh-token.service';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { PermissionLoaderService } from '../authorization/permission-loader.service';
import { WorkspaceOwnershipPolicy } from '../workspaces/workspace-ownership.policy';
import { CreateUserDto } from './dto/create-user.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateAuthUserEmailDto } from './dto/update-auth-user-email.dto';
import { UpdateAuthUserInfoDto } from './dto/update-auth-user-info.dto';
import { UpdateAuthUserPasswordDto } from './dto/update-auth-user-password.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserPermissionsResponseDto } from './dto/user-permissions-response.dto';
import { VerifyAuthUserPhoneDto } from './dto/verify-auth-user-phone.dto';

const OTP_EXPIRY_MS = 15 * 60 * 1000;
const PASSWORD_RESET_EXPIRY_MINUTES = 60;

function generateOtp(): string {
  // 6 digits, zero-padded. Phone verification only; bounded by the 15-min
  // expiry and the verify endpoint's throttle.
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly smsService: SmsService,
    private readonly destinationSendLimit: DestinationSendLimitService,
    private readonly auditService: AuditService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly queueProducer: QueueProducerService,
    // `forwardRef` on both sides: AuthModule imports UsersModule for the login
    // path, and UsersModule needs session revocation back. Per CLAUDE.md, the
    // ref goes in the module imports AND on the injection.
    @Inject(forwardRef(() => RefreshTokenService))
    private readonly refreshTokenService: RefreshTokenService,
    private readonly permissionLoaderService: PermissionLoaderService,
    // The ownership invariant is enforced from BOTH sides. Deleting an account
    // is the other half of "a live workspace always has an active owner"; drop
    // it and a deleted owner leaves the workspace ownerless.
    private readonly workspaceOwnershipPolicy: WorkspaceOwnershipPolicy,
  ) {}

  // ── Account emails ──────────────────────────────────────────────────
  // Queued so the request never waits on the mail provider. The payload
  // carries the user id only; the worker reloads the user and renders the
  // message, so no address or token sits in Redis.

  private async queueEmailVerification(userId: string): Promise<void> {
    await this.queueProducer.enqueue(JobName.USER_EMAIL_VERIFICATION_V1, {
      payloadVersion: 1,
      userId,
    });
  }

  /**
   * Records an email change and, when the previous address was verified,
   * tells it. Without this an account taken over with a stolen password could
   * move its email first, and every later alert — the password-changed notice
   * included — would go to the attacker. The previous address travels in the
   * audit row; the job carries only that row's id.
   */
  private async recordEmailChange(
    user: User,
    newEmail: string,
    actorId: string | null,
  ): Promise<void> {
    const auditLogId = await this.auditService.record({
      action: 'user.email_changed',
      actorId,
      targetUserId: user.id,
      metadata: { previousEmail: user.email, newEmail },
    });
    // An unverified previous address was never proven to be the owner's, so
    // it gets nothing — otherwise moving an account's email back and forth
    // would mail an inbox the account never controlled.
    if (!user.emailVerifiedAt) {
      return;
    }
    if (!auditLogId) {
      this.logger.error(
        `Email-changed notice not queued for user ${user.id}: the audit write failed`,
      );
      return;
    }
    // The email change has already committed; a queue outage here must not
    // turn it into a failed request that also skips the verification email.
    await this.queueProducer
      .enqueue(JobName.USER_EMAIL_CHANGED_NOTICE_V1, {
        payloadVersion: 1,
        userId: user.id,
        auditLogId,
      })
      .catch((error: unknown) =>
        this.logger.error(
          `Email-changed notice not queued for user ${user.id}: ${formatErrorMessage(error)}`,
        ),
      );
  }

  private async queuePasswordChangedNotice(userId: string): Promise<void> {
    await this.queueProducer.enqueue(JobName.USER_PASSWORD_CHANGED_NOTICE_V1, {
      payloadVersion: 1,
      userId,
      occurredAt: new Date().toISOString(),
    });
  }

  /**
   * Worker side of `USER_EMAIL_VERIFICATION_V1`. Nothing to send when the
   * account is gone or already verified; skipped when the address has used its
   * send budget. The link is a 24h JWT whose `purpose` claim stops it being
   * used as an access token.
   */
  async deliverEmailVerification(userId: string): Promise<DeliveryOutcome> {
    const user = await this.findByIdOrNull(userId);
    if (!user || user.emailVerifiedAt) {
      return 'nothing-to-send';
    }
    const sent = await this.destinationSendLimit.sendWithinLimit(
      SendPurpose.EMAIL_VERIFICATION,
      canonicalEmailDestination(user.email),
      async () => {
        const token = this.jwtService.sign(
          // Bound to the address it is mailed to: redeeming it verifies THAT
          // address, never whatever the account holds by the time the link is
          // opened (see verifyEmailByToken).
          { sub: user.id, purpose: 'email_verify', email: user.email },
          { expiresIn: '24h' },
        );
        const baseUrl = this.configService.getOrThrow<string>('apiBaseUrl');
        await this.emailService.sendEmailVerificationLink(
          user.email,
          user.firstName,
          `${baseUrl}/auth/verify-email?token=${encodeURIComponent(token)}`,
        );
      },
    );
    return sent ? 'sent' : 'destination-limited';
  }

  /**
   * Worker side of `USER_PASSWORD_RESET_V1`: mints a random token, stores its
   * SHA-256 hash with a 60-minute expiry (replacing any earlier one), and
   * emails the reset link. Nothing to send when the account can't be reset.
   *
   * The send budget is checked BEFORE the token is minted. Minting replaces
   * the stored hash, so a limited request that still minted would kill the
   * link the account holder already has and send nothing in its place —
   * letting anyone lock a victim out of recovery by requesting resets.
   */
  async deliverPasswordReset(userId: string): Promise<DeliveryOutcome> {
    const user = await this.findByIdOrNull(userId);
    if (!user || !user.isActive) {
      return 'nothing-to-send';
    }
    const sent = await this.destinationSendLimit.sendWithinLimit(
      SendPurpose.PASSWORD_RESET,
      canonicalEmailDestination(user.email),
      () => this.mintAndSendPasswordReset(user),
    );
    return sent ? 'sent' : 'destination-limited';
  }

  private async mintAndSendPasswordReset(user: User): Promise<void> {
    const token = generateOpaqueToken();
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        otpHash: hashOpaqueToken(token),
        otpPurpose: OtpPurpose.PASSWORD_RESET,
        otpExpiresAt: new Date(
          Date.now() + PASSWORD_RESET_EXPIRY_MINUTES * 60 * 1000,
        ),
      },
    });
    const resetUrl = new URL(
      this.configService.getOrThrow<string>('passwordResetUrl'),
    );
    resetUrl.searchParams.set('token', token);
    resetUrl.searchParams.set('email', user.email);
    await this.emailService.sendPasswordResetLink(
      user.email,
      user.firstName,
      resetUrl.toString(),
      PASSWORD_RESET_EXPIRY_MINUTES,
    );
  }

  /** Worker side of `USER_PASSWORD_CHANGED_NOTICE_V1`. */
  async deliverPasswordChangedNotice(
    userId: string,
    occurredAt: Date,
  ): Promise<DeliveryOutcome> {
    const user = await this.findByIdOrNull(userId);
    if (!user) {
      return 'nothing-to-send';
    }
    const send = () =>
      this.emailService.sendPasswordChangedNotification(
        user.email,
        user.firstName,
        occurredAt,
      );
    // A verified address always gets this alert: it is the one an account
    // takeover would most like to suppress. An UNVERIFIED address is capped,
    // because anyone can point their own account at a victim's inbox (the
    // email change stores the new address unverified) and then change their
    // own password over and over.
    if (user.emailVerifiedAt) {
      await send();
      return 'sent';
    }
    const sent = await this.destinationSendLimit.sendWithinLimit(
      SendPurpose.UNVERIFIED_PASSWORD_CHANGED_NOTICE,
      canonicalEmailDestination(user.email),
      send,
    );
    return sent ? 'sent' : 'destination-limited';
  }

  /**
   * Worker side of `USER_EMAIL_CHANGED_NOTICE_V1`. Uncapped: it is only queued
   * for a previous address that was verified, so it reaches nobody but the
   * address's proven owner.
   */
  async deliverEmailChangedNotice(
    userId: string,
    auditLogId: string,
  ): Promise<DeliveryOutcome> {
    const user = await this.findByIdOrNull(userId);
    const change = await this.prisma.auditLog.findFirst({
      where: {
        id: auditLogId,
        action: 'user.email_changed',
        targetUserId: userId,
      },
      select: { createdAt: true, metadata: true },
    });
    const previousEmail = (change?.metadata as { previousEmail?: unknown })
      ?.previousEmail;
    if (!user || !change || typeof previousEmail !== 'string') {
      return 'nothing-to-send';
    }
    await this.emailService.sendEmailChangedNotification(
      previousEmail,
      user.firstName,
      change.createdAt,
    );
    return 'sent';
  }

  // Consume a verification JWT. No-op for an already-verified user. Every
  // failure (bad signature, wrong purpose, expired, unknown user) is
  // INVALID_LINK.
  async verifyEmailByToken(token: string): Promise<void> {
    interface VerifyPayload {
      sub?: unknown;
      purpose?: unknown;
      email?: unknown;
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
    // The link proves control of the address it was sent to, and only that
    // one. Without this check a link for the owner's own address, redeemed
    // after the account's email was changed, would mark the NEW address —
    // which nobody has proven they control — as verified.
    if (!user || payload.email !== user.email) {
      throw Errors.invalidLink();
    }
    if (user.emailVerifiedAt) {
      return;
    }
    // Conditional on the address the link was mailed to, not just the id: the
    // check above read the row unlocked, and an email change committing in
    // between must not let this write verify the NEW address.
    const verified = await this.prisma.user.updateMany({
      where: {
        id: user.id,
        email: payload.email,
        emailVerifiedAt: null,
        deletedAt: null,
      },
      data: { emailVerifiedAt: new Date(), updatedBy: user.id },
    });
    if (verified.count !== 1) {
      const current = await this.findByIdOrNull(user.id);
      // Verified concurrently by the same link — the outcome it asked for.
      if (current?.email === payload.email && current.emailVerifiedAt) {
        return;
      }
      throw Errors.invalidLink();
    }
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
    await this.queueEmailVerification(user.id);
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
        // Every status, not only ACTIVE. A client showing "your workspaces"
        // needs to render a suspended or pending membership differently rather
        // than have it silently vanish — and `rules` above already reflects the
        // truth about authority, since only ACTIVE memberships compile into
        // grants. This list is context, not permission.
        memberships: {
          select: {
            id: true,
            workspaceId: true,
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
      workspaceMemberships: (user?.memberships ?? []).map((membership) => ({
        membershipId: membership.id,
        workspaceId: membership.workspaceId,
        roleName: membership.role.name,
        status: membership.status as WorkspaceMembershipStatus,
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
    const newEmail = dto.email?.toLowerCase();
    const isEmailChanged =
      newEmail !== undefined && newEmail !== existing.email;

    const updateData: Prisma.UserUpdateInput = {
      email: newEmail,
      // A new address is unverified until its owner follows the link.
      ...(isEmailChanged ? { emailVerifiedAt: null } : {}),
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
    // authenticate — `JwtStrategy` refuses it on every request — so a workspace
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
          isEmailChanged,
        },
      });
    }
    if (isEmailChanged) {
      await this.recordEmailChange(existing, newEmail, actorId);
      await this.queueEmailVerification(id);
    }
    return updated;
  }

  /**
   * Active → inactive, with the ownership invariant and the session end that a
   * bare field write would skip.
   *
   * Refused when the account is somebody's last owner. A platform admin is not
   * exempt: `manage all` bypasses AUTHORIZATION, not data integrity, and the
   * unadministrable workspace it would leave behind is invisible to every roster
   * read — so nobody would find it to repair it.
   */
  private async deactivate(
    userId: string,
    updateData: Prisma.UserUpdateInput,
    actorId: string | null,
  ): Promise<User> {
    const deactivated = await this.prisma.$transaction(async (transaction) => {
      // User row first, then workspaces — the order in `row-lock.util.ts`.
      await this.refreshTokenService.lockSessions(transaction, userId);
      await this.workspaceOwnershipPolicy.assertUserIsNotASoleOwner(
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
    // Their workspace-scoped grants are gone the instant the row says inactive.
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
    // relationship. The workspaces are closed in the same transaction instead —
    // never left ownerless, never left live.
    const { workspaces: closedWorkspaces, affectedUserIds } =
      await this.prisma.$transaction(async (transaction) => {
        // User row first, then the workspaces — the order documented in
        // `row-lock.util.ts`. Taking the workspaces first is the opposite of
        // what every membership mutation takes, so the two sides of the
        // ownership invariant would deadlock against each other.
        await this.refreshTokenService.lockSessions(transaction, userId);
        const closed =
          await this.workspaceOwnershipPolicy.closeSolelyOwnedWorkspaces(
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
      // Ids only. The workspace NAMES are personal data in a single-proprietor
      // tenant, and writing them into the audit trail during an erasure would
      // re-create exactly what the erasure just removed.
      metadata: {
        closedWorkspaceIds: closedWorkspaces.map((workspace) => workspace.id),
      },
    });
  }

  /**
   * Soft-delete an account, refusing to strand a workspace without an owner.
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
      // User row first, then workspaces — see `row-lock.util.ts`. This is also
      // what makes the check below binding: a promotion racing this deletion
      // contends on the SAME user row, so it either loses and finds the account
      // gone, or wins and is counted here.
      await this.refreshTokenService.lockSessions(transaction, userId);
      await this.workspaceOwnershipPolicy.assertUserIsNotASoleOwner(
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
    // suspension (a separate domain concept from deletion), not to
    // double-signal lifecycle state. The row stays for audit/FK integrity;
    // call gdprErase for true PII removal.
    //
    // Refused while the user is the last active owner of a live workspace — the
    // response names them, and the remedy (transfer ownership, or delete the
    // workspace) is entirely in the caller's hands. `POST /users/me/gdpr-erase`
    // is the path that cannot be refused, and it closes those workspaces
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
   * Moves the account to a new address and emails a verification link there.
   * The address is the recovery channel, so every OTHER session ends; the
   * caller gets a fresh session (their current tokens die with the cutoff).
   */
  async updateEmail(
    userId: string,
    dto: UpdateAuthUserEmailDto,
    context: RefreshTokenContext = {},
  ): Promise<{ user: User; tokens: SessionTokens }> {
    const user = await this.findById(userId);
    const passwordMatches = await bcrypt.compare(
      dto.currentPassword,
      user.password,
    );
    if (!passwordMatches) {
      throw Errors.currentPasswordIncorrect();
    }
    const newEmail = dto.newEmail.toLowerCase();
    const updated = await this.refreshTokenService.endAllSessions(
      userId,
      userId,
      { email: newEmail, emailVerifiedAt: null },
    );
    if (newEmail !== user.email) {
      await this.recordEmailChange(user, newEmail, userId);
    }
    await this.queueEmailVerification(userId);
    const tokens = await this.refreshTokenService.startSession(
      userId,
      updated.passwordChangedAt,
      context,
    );
    return { user: updated, tokens };
  }

  /**
   * THE credential write: hash, cutoff bump and revocation of every refresh
   * family, in one transaction. There is no way to change a password without
   * ending the account's sessions. `extraData` lands in the same row update.
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

  /**
   * Changes the caller's password and ends every OTHER session, like Laravel's
   * `logoutOtherDevices` / Django's `update_session_auth_hash`: the caller gets
   * a fresh session in the response.
   */
  async updateOwnPassword(
    userId: string,
    dto: UpdateAuthUserPasswordDto,
    context: RefreshTokenContext = {},
  ): Promise<{ user: User; tokens: SessionTokens }> {
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
      userId,
    );
    await this.queuePasswordChangedNotice(userId);
    const tokens = await this.refreshTokenService.startSession(
      userId,
      updated.passwordChangedAt,
      context,
    );
    return { user: updated, tokens };
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
    await this.queuePasswordChangedNotice(userId);
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
    // The number's send budget is checked before the OTP is minted, so a
    // refused request leaves the caller's last code valid. A refusal answers
    // exactly like a send: whether anyone else recently texted this number is
    // not the caller's to learn. If Redis cannot answer, no SMS goes out —
    // failing open would turn a Redis outage into unlimited SMS spend.
    const reservation = await this.destinationSendLimit
      .reserve(SendPurpose.PHONE_VERIFICATION, phoneNumber)
      .catch((error: unknown) => {
        this.logger.error(
          `SMS send limit unavailable: ${formatErrorMessage(error)}`,
        );
        throw Errors.externalServiceUnavailable(
          'Phone verification is temporarily unavailable.',
        );
      });
    if (!reservation) {
      return;
    }
    await this.destinationSendLimit.sendReserved(reservation, async () => {
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
    });
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

  // Public "resend my verification email". Silent no-op when the address is
  // unknown or already verified, so the response never varies.
  async resendEmailVerification(email: string): Promise<void> {
    const user = await this.findByEmail(email);
    if (!user || user.emailVerifiedAt) {
      return;
    }
    await this.queueEmailVerification(user.id);
  }

  // Same answer for every address; the link is only sent to a live account.
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.findByEmail(email);
    if (!user || !user.isActive) {
      return;
    }
    await this.queueProducer.enqueue(JobName.USER_PASSWORD_RESET_V1, {
      payloadVersion: 1,
      userId: user.id,
    });
  }

  /**
   * Redeems a reset link: single use, 60-minute expiry, and every session the
   * account holds ends. Every failure is INVALID_LINK.
   */
  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const user = await this.findByEmail(dto.email);
    if (
      !user ||
      !user.isActive ||
      !user.otpHash ||
      user.otpPurpose !== OtpPurpose.PASSWORD_RESET ||
      !user.otpExpiresAt ||
      user.otpExpiresAt.getTime() < Date.now() ||
      !isSameHash(hashOpaqueToken(dto.token), user.otpHash)
    ) {
      throw Errors.invalidLink();
    }
    await this.applyPasswordChange(user.id, dto.newPassword, user.id, {
      otpHash: null,
      otpPurpose: null,
      otpExpiresAt: null,
    });
    await this.auditService.record({
      action: 'password.reset.completed',
      actorId: user.id,
      targetUserId: user.id,
    });
    await this.queuePasswordChangedNotice(user.id);
  }

  // ── Support operations ─────────────────────────────────────────────────
  // Narrow capabilities held by PLATFORM_APP_SUPPORT, each its own permission
  // so support can help an account holder without being able to edit them.

  /**
   * Ends every session the account holds, on every device: revokes the refresh
   * chains and moves the cutoff, so live access tokens (`JWT_EXPIRES_IN`,
   * 15 minutes by default) stop working immediately rather than at expiry.
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
    await this.queueEmailVerification(user.id);
    await this.auditService.record({
      action: 'user.verification_resent_by_support',
      actorId,
      targetUserId: user.id,
    });
  }
}

/** Constant-time comparison of two hex digests. */
function isSameHash(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
