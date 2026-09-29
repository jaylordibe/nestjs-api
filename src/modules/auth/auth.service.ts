import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { AuditService } from '../../common/audit/audit.service';
import { Errors } from '../../common/errors/errors';
import {
  extractEmailDomain,
  isDisposableEmail,
} from '../../common/util/disposable-email.util';
import { RedisService } from '../../common/redis/redis.service';
import { hashPassword } from '../../common/util/password-hashing.util';
import { UserResponseDto } from '../users/dto/user-response.dto';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import { RegisterDto } from './dto/register.dto';
import { RegisterResponseDto } from './dto/register-response.dto';
import type { RefreshTokenContext } from './refresh-token.service';
import { RefreshTokenService } from './refresh-token.service';
import { LOGOUT_KEY_PREFIX } from './strategies/jwt.strategy';

@Injectable()
export class AuthService {
  // Compared against when the identifier matches no account, so an unknown
  // identifier costs the same bcrypt work as a wrong password. Computed lazily
  // so it uses the configured cost factor.
  private dummyHash: string | null = null;

  constructor(
    private readonly usersService: UsersService,
    private readonly redis: RedisService,
    private readonly auditService: AuditService,
    private readonly refreshTokenService: RefreshTokenService,
  ) {}

  async register(dto: RegisterDto): Promise<RegisterResponseDto> {
    if (isDisposableEmail(dto.email)) {
      throw Errors.emailDomainDisallowed(extractEmailDomain(dto.email) ?? '');
    }
    if (await this.usersService.findByEmail(dto.email)) {
      throw Errors.uniqueConstraintViolation('email');
    }
    // `create` queues the verification email.
    const user = await this.usersService.create(dto, null);
    // The only place a self-signup's request envelope (ip, user agent,
    // request id) is persisted; AuditService attaches it automatically.
    await this.auditService.record({
      action: 'user.registered',
      actorId: null,
      targetUserId: user.id,
    });
    return {
      message: 'Check your email to verify your account before logging in.',
    };
  }

  async login(
    dto: LoginDto,
    context: RefreshTokenContext = {},
  ): Promise<LoginResponseDto> {
    // Soft-deleted accounts resolve to null, the same as an unknown identifier.
    const user = await this.usersService.findByEmailOrUsername(dto.identifier);
    const passwordMatches = await bcrypt.compare(
      dto.password,
      user?.password ?? (await this.getDummyHash()),
    );
    if (!user || !user.isActive || !passwordMatches) {
      throw Errors.invalidCredentials();
    }
    // After the password check, so only the password holder learns the
    // account exists but is unverified.
    if (!user.emailVerifiedAt) {
      throw Errors.emailNotVerified();
    }
    // The cutoff read with the password check authorises the session; a
    // revocation committing before issue is refused inside `startSession`.
    const tokens = await this.refreshTokenService.startSession(
      user.id,
      user.passwordChangedAt,
      context,
    );
    return { ...tokens, user: new UserResponseDto(user) };
  }

  /**
   * Exchanges a refresh token for a fresh pair. The user is re-read under the
   * rotation lock, so deactivation, deletion or a credential change ends the
   * session at its next refresh.
   */
  async refresh(
    presentedToken: string,
    context: RefreshTokenContext = {},
  ): Promise<LoginResponseDto> {
    const { user, tokens } = await this.refreshTokenService.refreshSession(
      presentedToken,
      context,
    );
    return { ...tokens, user: new UserResponseDto(user) };
  }

  private async getDummyHash(): Promise<string> {
    if (!this.dummyHash) {
      this.dummyHash = await hashPassword('dummy-password-for-timing');
    }
    return this.dummyHash;
  }

  /**
   * Ends this device's session: revokes the presented refresh chain and
   * blocklists the current access token's `jti` until it expires. Other
   * devices stay signed in.
   */
  async logout(
    currentUser: AuthenticatedUser,
    presentedRefreshToken?: string,
  ): Promise<void> {
    if (presentedRefreshToken) {
      await this.refreshTokenService.revokeByToken(presentedRefreshToken);
    }

    if (!currentUser.jti || !currentUser.exp) {
      await this.auditService.record({
        action: 'auth.logout.no_jti',
        actorId: currentUser.id,
        targetUserId: currentUser.id,
      });
      return;
    }
    const ttlSeconds = Math.max(
      1,
      currentUser.exp - Math.floor(Date.now() / 1000),
    );
    await this.redis.client.set(
      `${LOGOUT_KEY_PREFIX}${currentUser.jti}`,
      '1',
      'EX',
      ttlSeconds,
    );
    await this.auditService.record({
      action: 'auth.logout',
      actorId: currentUser.id,
      targetUserId: currentUser.id,
      metadata: { jti: currentUser.jti },
    });
  }

  /**
   * Logout-everywhere: moves the session cutoff (kills access tokens) and
   * revokes every refresh family, in one transaction.
   */
  async logoutAll(userId: string): Promise<void> {
    await this.refreshTokenService.endAllSessions(userId, userId);
    await this.auditService.record({
      action: 'auth.logout_all',
      actorId: userId,
      targetUserId: userId,
    });
  }
}
