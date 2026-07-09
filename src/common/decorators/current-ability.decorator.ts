import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { AppAbility } from '../authorization/app-ability';

export interface RequestWithAbility {
  ability?: AppAbility;
}

// The caller's compiled CASL ability, built once per request by
// `PermissionsGuard` and attached to the request.
//
// Only ever present on handlers guarded by `@RequirePermission()`. `@Public()`
// handlers have no user and therefore no ability; `@AuthenticatedOnly()`
// handlers get one only if they need it (the guard builds it lazily), so this
// decorator throws rather than hand back `undefined` and let a service treat
// "no ability" as "no restrictions".
export const CurrentAbility = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AppAbility => {
    const request = context.switchToHttp().getRequest<RequestWithAbility>();
    if (!request.ability) {
      throw new Error(
        '@CurrentAbility() used on a handler with no ability on the request. ' +
          'Decorate the handler with @RequirePermission(action, subject) — ' +
          '@Public() handlers have no authenticated caller.',
      );
    }
    return request.ability;
  },
);
