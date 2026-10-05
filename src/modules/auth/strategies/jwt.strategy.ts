import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { Errors } from '../../../common/errors/errors';
import { isAccessTokenPayload } from '../../../common/util/access-token.util';
import { RedisService } from '../../../common/redis/redis.service';
import { UsersService } from '../../users/users.service';

export interface JwtPayload {
  sub: string;
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string;
  jti?: string;
  // Set only on non-access tokens — see isAccessTokenPayload.
  purpose?: string;
}

export const LOGOUT_KEY_PREFIX = 'logout:jti:';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(
    configService: ConfigService,
    private readonly usersService: UsersService,
    private readonly redis: RedisService,
  ) {
    const serviceName = configService.getOrThrow<string>('serviceName');
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('jwt.secret'),
      issuer: serviceName,
      audience: serviceName,
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    // Reject tokens that were signed for a non-auth purpose (e.g.
    // email-verification JWTs).
    if (!isAccessTokenPayload(payload)) {
      throw Errors.tokenInvalid();
    }

    // findByIdOrNull uses the scoped client, so soft-deleted users return
    // null here automatically — no explicit deletedAt check needed.
    // Missing / inactive / soft-deleted all collapse to USER_INACTIVE so
    // they're indistinguishable (no enumeration via the auth path).
    const user = await this.usersService.findByIdOrNull(payload.sub);
    if (!user || !user.isActive) {
      throw Errors.userInactive();
    }

    // Invalidate every token issued before the password was last changed.
    //
    // `iat` is whole seconds (RFC 7519 §4.1.6) and `passwordChangedAt` has
    // millisecond precision, so a naive comparison leaves a sub-second hole: a
    // change at 10.400s floors to 10, and a token minted at 10.100s carries
    // `iat = 10`, which is not `< 10` — it survives the very control the user
    // invoked to kill it.
    //
    // The rounding is handled at the WRITE instead (`nextWholeSecond`, used by
    // every credential change and by logout-all), so this comparison stays a
    // plain floor. Fixing it here instead was tried and is wrong: account
    // creation also stamps `passwordChangedAt`, so rounding up on read rejects
    // a brand-new user's first login whenever it lands in the same second as
    // their registration.
    if (user.passwordChangedAt && payload.iat !== undefined) {
      const changedAtSeconds = Math.floor(
        user.passwordChangedAt.getTime() / 1000,
      );
      if (payload.iat < changedAtSeconds) {
        throw Errors.sessionInvalidated();
      }
    }

    // Per-token revocation via Redis blocklist. Logout writes the jti to
    // Redis with a TTL matching the token's remaining lifetime, so we just
    // check existence. Fail-open on Redis outage (log + allow) — a Redis
    // incident shouldn't cascade into a full auth outage. The tradeoff is
    // accepted: revocation is best-effort when Redis is unreachable.
    if (payload.jti) {
      try {
        const revoked = await this.redis.client.exists(
          `${LOGOUT_KEY_PREFIX}${payload.jti}`,
        );
        if (revoked) {
          throw Errors.tokenRevoked();
        }
      } catch (error) {
        if (error instanceof HttpException) throw error;
        this.logger.warn(
          `Logout blocklist check failed (failing open): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // No roles or permissions here. `PermissionsGuard` derives the caller's
    // ability from the database (cached in Redis, explicitly invalidated on
    // every role change), so a revoked role takes effect on the next request
    // rather than at token expiry.
    return {
      id: user.id,
      email: user.email,
      jti: payload.jti,
      exp: payload.exp,
    };
  }
}
