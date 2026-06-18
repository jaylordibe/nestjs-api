import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { AuditService } from '../../common/audit/audit.service';
import { Errors } from '../../common/errors/errors';
import {
  extractEmailDomain,
  isDisposableEmail,
} from '../../common/util/disposable-email.util';
import { RedisService } from '../../common/redis/redis.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UserResponseDto } from '../users/dto/user-response.dto';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtPayload, LOGOUT_KEY_PREFIX } from './strategies/jwt.strategy';

export interface LoginResponse {
  accessToken: string;
  user: UserResponseDto;
}

export interface RegisterResponse {
  // Intentionally just a message — no user object, no access token. Keeps
  // the pre-verification response surface minimal (nothing useful for an
  // attacker probing whether an email is registered) and reinforces that
  // the user must verify + log in before they have a session.
  message: string;
}

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

@Injectable()
export class AuthService {
  // Constant dummy hash used when the email doesn't exist, so login timing
  // doesn't leak whether an account is registered. Lazily computed on first
  // use so it matches BCRYPT_ROUNDS without hardcoding the value.
  private dummyHash: string | null = null;

  // The success response message — extracted so the silent disposable-email
  // path returns BYTE-IDENTICAL output to a real registration. Any divergence
  // (different message/shape) would tell an attacker which branch they hit.
  private static readonly REGISTER_OK_MESSAGE =
    'Check your email to verify your account before logging in.';

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly auditService: AuditService,
  ) {}

  async register(dto: RegisterDto): Promise<RegisterResponse> {
    // Disposable-email registrations are silently dropped: same 201 + same
    // message as a real registration, but no user is created and no
    // verification email is sent. Attackers probing for "which domains are
    // blocked" see uniform success and can't enumerate. An internal
    // `audit_logs` entry captures the attempt so ops can track patterns.
    if (isDisposableEmail(dto.email)) {
      await this.auditService.record({
        action: 'user.register_blocked_disposable_email',
        actorId: null,
        metadata: {
          email: dto.email,
          domain: extractEmailDomain(dto.email) ?? '',
        },
      });
      return { message: AuthService.REGISTER_OK_MESSAGE };
    }
    const user = await this.usersService.create(dto, null);
    // Fire the verification email immediately. The call is awaited so a
    // provider outage surfaces as a 5xx at registration time instead of
    // a silent "email never arrives" issue users only notice later.
    await this.usersService.sendEmailVerificationLink(user);
    return { message: AuthService.REGISTER_OK_MESSAGE };
  }

  async login(dto: LoginDto): Promise<LoginResponse> {
    // Reject disposable-email logins up-front, collapsed into the generic
    // INVALID_CREDENTIALS so an attacker can't tell the disposable check (vs
    // unknown email / wrong password) is what rejected them. A dummy bcrypt
    // compare on the same code path the unknown-email branch uses keeps the
    // response timing indistinguishable. The block is captured in audit_logs.
    if (isDisposableEmail(dto.email)) {
      await bcrypt.compare(dto.password, await this.getDummyHash());
      await this.auditService.record({
        action: 'user.login_blocked_disposable_email',
        actorId: null,
        metadata: {
          email: dto.email,
          domain: extractEmailDomain(dto.email) ?? '',
        },
      });
      throw Errors.invalidCredentials();
    }
    const user = await this.usersService.findByEmail(dto.email);

    // findByEmail uses the scoped client — soft-deleted users return null,
    // so this branch treats them identically to "email doesn't exist"
    // (down to the dummy bcrypt compare for timing).

    // Check lockout *before* doing work. Still do a dummy compare so locked
    // accounts can't be distinguished from wrong-password by timing either.
    if (user && user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await bcrypt.compare(dto.password, await this.getDummyHash());
      throw Errors.invalidCredentials();
    }

    const passwordMatches = await bcrypt.compare(
      dto.password,
      user?.password ?? (await this.getDummyHash()),
    );

    if (!user || !user.isActive || !passwordMatches) {
      if (user) {
        await this.registerFailedAttempt(user.id, user.failedLoginCount);
      }
      throw Errors.invalidCredentials();
    }

    // Verified-email check happens AFTER password verification so that
    // "is this email registered but unverified?" leaks only to someone
    // who already knows the correct password — much smaller enumeration
    // surface than blocking at the top of the function. Surfaces as 401
    // errorCode EMAIL_NOT_VERIFIED; wrong-password stays generic
    // INVALID_CREDENTIALS so the two are indistinguishable to an attacker.
    if (!user.emailVerifiedAt) {
      throw Errors.emailNotVerified();
    }

    if (user.failedLoginCount > 0 || user.lockedUntil) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: null },
      });
    }

    return this.buildLoginResponse(user);
  }

  private async registerFailedAttempt(
    userId: string,
    previousCount: number,
  ): Promise<void> {
    const nextCount = previousCount + 1;
    const reachedThreshold = nextCount >= MAX_FAILED_ATTEMPTS;
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginCount: reachedThreshold ? 0 : nextCount,
        lockedUntil: reachedThreshold
          ? new Date(Date.now() + LOCKOUT_DURATION_MS)
          : undefined,
      },
    });
  }

  private async getDummyHash(): Promise<string> {
    if (!this.dummyHash) {
      // 12 rounds matches UsersService.BCRYPT_ROUNDS. Duplicated as a const
      // here to avoid coupling this module to the users module's internals.
      this.dummyHash = await bcrypt.hash('dummy-password-for-timing', 12);
    }
    return this.dummyHash;
  }

  // Per-token logout. Writes the current JWT's jti to the Redis blocklist
  // with a TTL equal to the token's remaining lifetime, so the key expires
  // on its own — no cleanup job needed. JwtStrategy rejects any subsequent
  // request carrying that jti. Other tokens for the same user (other
  // devices) are unaffected; use logoutAll for "sign me out everywhere."
  async logout(current: AuthenticatedUser): Promise<void> {
    if (!current.jti || !current.exp) {
      // Legacy token issued before jti/exp were wired through — nothing to
      // revoke. Still record the audit event so the action isn't invisible.
      await this.auditService.record({
        action: 'auth.logout.no_jti',
        actorId: current.id,
        targetUserId: current.id,
      });
      return;
    }
    const ttlSeconds = Math.max(1, current.exp - Math.floor(Date.now() / 1000));
    await this.redis.client.set(
      `${LOGOUT_KEY_PREFIX}${current.jti}`,
      '1',
      'EX',
      ttlSeconds,
    );
    await this.auditService.record({
      action: 'auth.logout',
      actorId: current.id,
      targetUserId: current.id,
      metadata: { jti: current.jti },
    });
  }

  // Logout-everywhere. Bumps passwordChangedAt to now; JwtStrategy rejects
  // every token with iat earlier than that second. Same mechanism used by
  // password change — all the user's active sessions die on the next
  // request. No Redis writes needed; scales to however many devices the
  // user has logged in on.
  async logoutAll(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordChangedAt: new Date() },
    });
    await this.auditService.record({
      action: 'auth.logout_all',
      actorId: userId,
      targetUserId: userId,
    });
  }

  private buildLoginResponse(
    user: Awaited<ReturnType<UsersService['findById']>>,
  ): LoginResponse {
    const payload: JwtPayload = { sub: user.id };
    return {
      // jwtid sets the `jti` claim. One per token, used by /auth/logout to
      // revoke this specific token via Redis without affecting others.
      accessToken: this.jwtService.sign(payload, { jwtid: randomUUID() }),
      user: new UserResponseDto(user),
    };
  }
}
