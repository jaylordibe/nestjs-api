import { Injectable } from '@nestjs/common';
import { AbilityBuilder } from '@casl/ability';
import { createPrismaAbility } from '@casl/prisma';
import type { AppAbility } from '../../common/authorization/app-ability';
import type {
  AuthorizationAction,
  AuthorizationSubject,
} from '../../common/authorization/permission-catalog';
import {
  resolveOwnerKey,
  resolveTenantKey,
} from '../../common/authorization/subject-key';
import { PermissionOwnership } from '../../common/enums/permission-ownership.enum';
import { RoleScope } from '../../common/enums/role-scope.enum';

// A permission as it reaches the factory: the identity columns only. The
// description and the row id are irrelevant to a CASL rule, so they never
// enter the Redis cache either.
export interface PermissionGrant {
  readonly action: AuthorizationAction;
  readonly subject: AuthorizationSubject;
  readonly scope: RoleScope;
  readonly ownership: PermissionOwnership;
}

export interface BusinessMembershipGrant {
  readonly businessId: string;
  readonly permissions: readonly PermissionGrant[];
}

// Everything the factory needs, already loaded. Kept as plain data so it can
// round-trip through JSON in the Redis grants cache.
export interface AuthorizationGrants {
  readonly platformPermissions: readonly PermissionGrant[];
  readonly businessMemberships: readonly BusinessMembershipGrant[];
}

@Injectable()
export class AbilityFactory {
  // Compiles a user's grants into one CASL ability.
  //
  // This is the "where" half of the model: a permission row records only WHAT
  // (action + subject), and the condition is derived here from the row's scope
  // and ownership plus the request context (`userId`, or the business a
  // membership is for). That is why `permissions` has no condition column.
  //
  // Pure and synchronous — loading lives in PermissionLoaderService.
  createForUser(userId: string, grants: AuthorizationGrants): AppAbility {
    const { can, build } = new AbilityBuilder<AppAbility>(createPrismaAbility);

    for (const permission of grants.platformPermissions) {
      if (permission.ownership === PermissionOwnership.OWN) {
        // "…but only the rows you own." `User` is keyed by `id`, its children
        // by `userId`; resolveOwnerKey throws rather than silently widening
        // to an unconditional rule.
        can(permission.action, permission.subject, {
          [resolveOwnerKey(permission.subject)]: userId,
        });
      } else {
        // Platform staff: unrestricted over the subject. `manage all` lands
        // here and, because CASL OR-composes rules, supersedes every narrower
        // rule the user also holds.
        can(permission.action, permission.subject);
      }
    }

    for (const membership of grants.businessMemberships) {
      for (const permission of membership.permissions) {
        // Business-scoped authority is bounded by the tenant, always. The
        // `Business` record itself is keyed by `id`; everything owned by a
        // business is keyed by `businessId`.
        can(permission.action, permission.subject, {
          [resolveTenantKey(permission.subject)]: membership.businessId,
        });
      }
    }

    return build();
  }
}
