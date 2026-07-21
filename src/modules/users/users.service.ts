import { Injectable, Logger } from '@nestjs/common';
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
import { OtpPurpose } from '../../common/enums/otp-purpose.enum';
import { SeededRoleName } from '../../common/enums/seeded-role-name.enum';
import {
  BCRYPT_ROUNDS,
  hashPassword,
} from '../../common/util/password-hashing.util';
import { RedisService } from '../../common/redis/redis.service';
import { PrismaService } from '../../prisma/prisma.service';
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
    // The user row and its PLATFORM_USER assignment are one atomic unit. A
    // user without that role holds no permissions at all — they could not even
    // read their own profile — so a partial write here would produce a broken
    // account. Covers both self-signup and admin-initiated creates.
    const user = await this.prisma.$transaction(async (transaction) => {
      const created = await transaction.user.create({
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

      const platformUserRole = await transaction.role.findUniqueOrThrow({
        where: { name: SeededRoleName.PLATFORM_USER },
        select: { id: true },
      });
      await transaction.userRole.create({
        data: {
          userId: created.id,
          roleId: platformUserRole.id,
          createdBy: actorId,
        },
      });

      return created;
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
        businessMembers: {
          select: { businessId: true, role: { select: { name: true } } },
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
      businessMemberships: (user?.businessMembers ?? []).map((membership) => ({
        businessId: membership.businessId,
        roleName: membership.role.name,
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
    await this.findById(id);

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

    if (dto.password) {
      updateData.password = await hashPassword(dto.password);
      updateData.passwordChangedAt = new Date();
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: updateData,
    });
    if (actorId && actorId !== id) {
      await this.auditService.record({
        action: 'user.updated.by_admin',
        actorId,
        targetUserId: id,
        metadata: {
          // Role changes no longer travel through this endpoint — they have
          // their own audited routes (`POST/DELETE /users/:userId/roles`).
          isActiveChanged: dto.isActive !== undefined,
          passwordChanged: Boolean(dto.password),
        },
      });
    }
    if (dto.password) {
      await this.notifyPasswordChanged(updated);
    }
    return updated;
  }

  async remove(id: string, actorId: string | null): Promise<void> {
    await this.findById(id);
    // Admin "delete" is soft — keeps the row for audit trail / recovery.
    // For true PII removal (GDPR right-to-be-forgotten) the user themselves
    // invokes gdprErase, which also anonymizes personal columns.
    await this.prisma.user.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        deletedBy: actorId,
        updatedBy: actorId,
      },
    });
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
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        email: `deleted-${userId}@deleted.invalid`,
        username: null,
        password: await hashPassword(`erased-${userId}-${now.getTime()}`),
        passwordChangedAt: now,
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
        updatedBy: userId,
      },
    });
    await this.auditService.record({
      action: 'user.gdpr_erased',
      actorId: userId,
      targetUserId: userId,
    });
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
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        deletedAt: new Date(),
        deletedBy: actorId,
        updatedBy: actorId,
      },
    });
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
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        email: dto.newEmail.toLowerCase(),
        emailVerifiedAt: null,
        updatedBy: actorId,
      },
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
    const passwordHash = await hashPassword(dto.newPassword);
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        password: passwordHash,
        passwordChangedAt: new Date(),
        updatedBy: actorId,
      },
    });
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
    const passwordHash = await hashPassword(newPassword);
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        password: passwordHash,
        passwordChangedAt: new Date(),
        updatedBy: actorId,
      },
    });
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
    const passwordHash = await hashPassword(dto.newPassword);
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        password: passwordHash,
        passwordChangedAt: new Date(),
        otpHash: null,
        otpPurpose: null,
        otpExpiresAt: null,
        failedLoginCount: 0,
        lockedUntil: null,
        updatedBy: user.id,
      },
    });
    await this.auditService.record({
      action: 'password.reset.completed',
      actorId: user.id,
      targetUserId: user.id,
    });
    await this.notifyPasswordChanged(updated);
  }
}
