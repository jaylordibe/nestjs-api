import { ExecutionContext, createParamDecorator } from '@nestjs/common';

// The authenticated caller's identity — NOT a full `User` row.
//
// Deliberately carries no role or permissions. Authorization is answered by the
// caller's compiled CASL ability (`@CurrentAbility()`), derived per request
// from `user_roles` / `business_members`. Caching a role here would create a
// second source of truth that goes stale the moment a role is revoked
// mid-session — and this template issues 30-day tokens.
export interface AuthenticatedUser {
  id: string;
  email: string;
  // Carried through from the JWT payload so the logout endpoint can revoke
  // the exact token it arrived on (via its `jti`) with the right Redis TTL
  // (derived from `exp`). Optional so callers that don't care can ignore them.
  jti?: string;
  exp?: number;
}

export const CurrentUser = createParamDecorator(
  (_: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context
      .switchToHttp()
      .getRequest<{ user: AuthenticatedUser }>();
    return request.user;
  },
);
