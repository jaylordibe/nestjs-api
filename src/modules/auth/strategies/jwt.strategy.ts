import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { Role } from '../../../common/enums/role.enum';
import { UsersService } from '../../users/users.service';

export interface JwtPayload {
  sub: string;
  iat?: number;
  iss?: string;
  aud?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly usersService: UsersService,
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

    return { id: user.id, email: user.email, role: user.role as Role };
  }
}
