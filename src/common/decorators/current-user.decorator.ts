import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { Role } from '../enums/role.enum';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
  // Carried through from the JWT payload so the logout endpoint can revoke
  // the exact token it arrived on (via its `jti`) with the right Redis TTL
  // (derived from `exp`). Optional so callers that don't care can ignore them.
  jti?: string;
  exp?: number;
}

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ user: AuthenticatedUser }>();
    return request.user;
  },
);
