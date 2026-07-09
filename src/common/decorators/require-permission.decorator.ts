import { SetMetadata, applyDecorators } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type {
  AuthorizationAction,
  AuthorizationSubject,
} from '../authorization/permission-catalog';

export const REQUIRE_PERMISSION_KEY = 'requirePermission';

export interface RequiredPermission {
  action: AuthorizationAction;
  subject: AuthorizationSubject;
  // When true, an ownership-scoped grant is NOT sufficient: the caller must
  // hold a rule that is not conditioned on owning the record. See below.
  administrative: boolean;
  // When true, holding no grant at all is answered as "does not exist"
  // (empty page / 404) rather than 403. See below.
  denyAsNotFound: boolean;
}

export interface RequirePermissionOptions {
  // Mark a handler that operates on records the caller does not own — the
  // administrative half of a resource (`GET /users`, `PATCH /users/:id`).
  //
  // Why this is needed: a guard runs before any record is loaded, so it can
  // only ask CASL "does ANY rule grant this action on this subject?" — and
  // that question ignores conditions. Without this flag, PLATFORM_USER's
  // `update User (own)` would pass the guard on `PATCH /users/:id`, because a
  // rule does exist. Setting `administrative: true` makes the guard demand a
  // rule that is not owner-conditioned, so self-service grants don't unlock
  // admin routes.
  //
  // Tenant-conditioned rules still qualify: a BUSINESS_ADMIN's
  // `update BusinessMember { businessId }` is administrative *within* its
  // business, and the tenant boundary is enforced by the query.
  administrative?: boolean;

  // Answer a caller who holds NO grant on this subject as though the resource
  // simply does not exist: an empty page for a list, 404 for a record — never
  // 403.
  //
  // Two reasons, both about tenant-scoped resources:
  //
  //  1. Truthfulness. A user who belongs to no business is not *forbidden*
  //     from listing businesses; they have none. `200 []` is the honest answer,
  //     and `GET /businesses` returning 403 would force every frontend to
  //     special-case it.
  //
  //  2. Consistency. Without this, a user WITH a business gets 404 on someone
  //     else's business (the query filters it out), while a user with NO
  //     business gets 403 from the guard — the same request answered two
  //     different ways depending on state the caller cannot see.
  //
  // This can never widen access: the query still scopes every row. It only
  // changes which refusal the caller sees. Pair with the `…OrEmpty` builders on
  // `AbilityScopedQueryService`, which yield a provably-empty filter instead of
  // throwing.
  denyAsNotFound?: boolean;
}

// Declares the authorization a handler needs. `PermissionsGuard` reads the
// metadata; the Swagger decorators come along for free so a protected route
// can never be documented as if it were open.
//
// Both arguments are typed against the catalog, so a typo is a COMPILE error
// rather than a runtime 403 discovered in production.
//
// The guard checks the SUBJECT TYPE, because no record is loaded yet. Row-level
// and tenant scoping happen in the query — see AbilityScopedQueryService.
export const RequirePermission = (
  action: AuthorizationAction,
  subject: AuthorizationSubject,
  options: RequirePermissionOptions = {},
): MethodDecorator & ClassDecorator =>
  applyDecorators(
    SetMetadata(REQUIRE_PERMISSION_KEY, {
      action,
      subject,
      administrative: options.administrative ?? false,
      denyAsNotFound: options.denyAsNotFound ?? false,
    } satisfies RequiredPermission),
    ApiBearerAuth(),
    ApiUnauthorizedResponse({
      description: 'Missing, invalid, expired, or revoked access token',
    }),
    ApiForbiddenResponse({
      description: options.administrative
        ? `Requires \`${action}\` on \`${subject}\` beyond your own records`
        : `Authenticated, but no permission grants \`${action}\` on \`${subject}\``,
    }),
  );
