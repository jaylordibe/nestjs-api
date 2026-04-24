import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { PaginationMeta } from '../../common/dto/paginated-response.dto';
import { AuditService } from '../../common/audit/audit.service';
import { EmailService } from '../../common/email/email.service';
import { OtpPurpose } from '../../common/enums/otp-purpose.enum';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateAuthUserEmailDto } from './dto/update-auth-user-email.dto';
import { UpdateAuthUserInfoDto } from './dto/update-auth-user-info.dto';
import { UpdateAuthUserPasswordDto } from './dto/update-auth-user-password.dto';
import { UpdateUserDto } from './dto/update-user.dto';

// OWASP 2024+ guidance. Bumping this is safe — existing hashes already
// encode their own cost factor and continue to verify correctly.
const BCRYPT_ROUNDS = 12;
const OTP_EXPIRY_MS = 15 * 60 * 1000;

function generateOtp(): string {
  // 6 digits, zero-padded. Brute-force risk is bounded by the 15-min expiry
  // window and the global throttle on verify/reset endpoints.
  const n = Math.floor(Math.random() * 1_000_000);
  return n.toString().padStart(6, '0');
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly auditService: AuditService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

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
    const baseUrl = this.configService.getOrThrow<string>('appBaseUrl');
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
    } catch (err) {
      this.logger.warn(
        `Failed to send password-change notification to ${user.email}: ${
          err instanceof Error ? err.message : String(err)
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
      throw new BadRequestException('Invalid or expired verification link');
    }
    if (payload.purpose !== 'email_verify' || typeof payload.sub !== 'string') {
      throw new BadRequestException('Invalid or expired verification link');
    }
    const user = await this.findByIdOrNull(payload.sub);
    if (!user) {
      throw new BadRequestException('Invalid or expired verification link');
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
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
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
        role: dto.role,
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
        metadata: { email: user.email, role: user.role },
      });
    }
    return user;
  }

  findAll(): Promise<User[]> {
    return this.prisma.user.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async findPaginated(
    query: PaginationQueryDto,
  ): Promise<{ data: User[]; meta: PaginationMeta }> {
    const page = query.page ?? 1;
    const perPage = query.perPage ?? 20;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
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

  // Admin-facing fetch — uses the raw client so admins can see soft-
  // deleted rows for recovery/audit. Paths that must reject deleted users
  // (auth, login, JwtStrategy) use findByIdOrNull / findByEmail, which go
  // through the scoped client.
  async findById(id: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
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

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.scoped.user.findUnique({
      where: { email: email.toLowerCase() },
    });
  }

  async update(
    id: string,
    dto: UpdateUserDto,
    actorId: string | null,
  ): Promise<User> {
    await this.findById(id);

    const data: Prisma.UserUpdateInput = {
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
      role: dto.role,
      isActive: dto.isActive,
      updatedBy: actorId,
    };

    if (dto.password) {
      data.password = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
      data.passwordChangedAt = new Date();
    }

    const updated = await this.prisma.user.update({ where: { id }, data });
    if (actorId && actorId !== id) {
      await this.auditService.record({
        action: 'user.updated.by_admin',
        actorId,
        targetUserId: id,
        metadata: {
          roleChanged: dto.role !== undefined,
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
      throw new UnauthorizedException('Current password is incorrect');
    }
    const now = new Date();
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        email: `deleted-${userId}@deleted.invalid`,
        username: null,
        password: await bcrypt.hash(
          `erased-${userId}-${now.getTime()}`,
          BCRYPT_ROUNDS,
        ),
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
      throw new UnauthorizedException('Current password is incorrect');
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
      throw new UnauthorizedException('Current password is incorrect');
    }
    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
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
      throw new ForbiddenException(
        'Use /users/me/password to change your own password',
      );
    }
    await this.findById(userId);
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
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
      throw new BadRequestException('Invalid or expired reset code');
    }
    const otpMatches = await bcrypt.compare(dto.otp, user.otpHash);
    if (!otpMatches) {
      throw new BadRequestException('Invalid or expired reset code');
    }
    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
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
