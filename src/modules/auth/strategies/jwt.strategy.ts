import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { Role } from '../../../common/enums/role.enum';
import { RedisService } from '../../../common/redis/redis.service';
import { UsersService } from '../../users/users.service';

export interface JwtPayload {
  sub: string;
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string;
  jti?: string;
  // Access tokens don't carry a purpose claim. Tokens signed for other
  // flows (email verification, future one-shot actions) do, and this
  // strategy rejects them so they can't be used as auth tokens.
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
    // email-verification JWTs). Access tokens never set `purpose`.
    if (payload.purpose !== undefined) {
      throw new UnauthorizedException();
    }

    // findByIdOrNull uses the scoped client, so soft-deleted users return
    // null here automatically — no explicit deletedAt check needed.
    const user = await this.usersService.findByIdOrNull(payload.sub);
    if (!user || !user.isActive) {
      throw new UnauthorizedException();
    }

    // Invalidate any token issued strictly before the second in which the
    // user's password was last changed. Tolerates sub-second jitter (a token
    // can be issued in the same second as the change and still verify) but
    // guarantees rejection for tokens issued ≥1s before. Catches stolen
    // tokens when the real user rotates their password.
    if (user.passwordChangedAt && payload.iat !== undefined) {
      const changedAtSeconds = Math.floor(
        user.passwordChangedAt.getTime() / 1000,
      );
      if (payload.iat < changedAtSeconds) {
        throw new UnauthorizedException();
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
          throw new UnauthorizedException();
        }
      } catch (err) {
        if (err instanceof UnauthorizedException) throw err;
        this.logger.warn(
          `Logout blocklist check failed (failing open): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return {
      id: user.id,
      email: user.email,
      role: user.role as Role,
      jti: payload.jti,
      exp: payload.exp,
    };
  }
}
