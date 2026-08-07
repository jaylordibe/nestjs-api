import { Injectable } from '@nestjs/common';
import { AbilityBuilder } from '@casl/ability';
import { createPrismaAbility } from '@casl/prisma';
import type { AppAbility } from '../../common/authorization/app-ability';
import {
  AUTHENTICATED_USER_PERMISSIONS,
  type AuthorizationAction,
  type AuthorizationSubject,
} from '../../common/authorization/permission-catalog';
import {
  resolveOwnerKey,
  resolveTenantKey,
} from '../../common/authorization/subject-key';
import { PermissionOwnership } from '../../common/enums/permission-ownership.enum';
import { BusinessMembershipStatus } from '../../common/enums/business-membership-status.enum';
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

// One ACTIVE membership, with enough context to authorize AND to debug.
//
// `roleId` / `roleName` / `status` are not read when compiling rules — the
// permissions alone decide that — but they are what makes a cached grant set
// answerable to "why can this person do that?" without a second query. An
// authorization cache you cannot read is one nobody trusts, and one nobody
// trusts gets bypassed.
export interface BusinessMembershipGrant {
  readonly membershipId: string;
  readonly businessId: string;
  readonly roleId: string;
  readonly roleName: string;
  readonly status: BusinessMembershipStatus;
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

    // ── What every authenticated caller can do, with no role at all ──────
    //
    // Injected FIRST and unconditionally, so an account with no platform role
    // and zero business memberships is still a complete, working account.
    // Modelling this as a role granted at signup would cost a `user_roles` row
    // per user and a special case in the revoke path to stop anyone breaking an
    // account by taking it away.
    // Every entry is ownership-scoped to `userId` or a read of the shared
    // role/permission vocabulary; nothing here reaches into a tenant.
    for (const permission of AUTHENTICATED_USER_PERMISSIONS) {
      if (permission.ownership === PermissionOwnership.OWN) {
        can(permission.action, permission.subject, {
          [resolveOwnerKey(permission.subject)]: userId,
        });
      } else {
        can(permission.action, permission.subject);
      }
    }

    for (const permission of grants.platformPermissions) {
      // ── THE scope guard ──────────────────────────────────────────────
      //
      // This loop branches on where a grant ARRIVED from, not on what the
      // permission claims to be, and the `else` below emits an UNCONDITIONAL
      // rule. Business permissions are always `ANY`, so a business permission
      // reaching this loop — a business role assigned through `user_roles` —
      // would compile to platform-wide authority with no tenant bound. That is
      // the single most dangerous shape this file can produce.
      //
      // Skipping rather than throwing is deliberate: a mis-scoped grant is a
      // data fault, and failing the whole request would turn one bad row into
      // an outage for that account. Dropping the rule fails closed.
      if (permission.scope !== RoleScope.PLATFORM) continue;

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

    // Only ACTIVE memberships confer authority — a suspended owner still holds
    // rank 100 on paper and must hold nothing in fact.
    //
    // `PermissionLoaderService` already filters on status in the query, so this
    // is defence in depth rather than the primary control. It is worth the two
    // lines because grants also arrive here deserialized from Redis, and a
    // cache is untrusted input: this is the last point at which a grant set can
    // be checked before it becomes a permission.
    for (const membership of grants.businessMemberships) {
      if (membership.status !== BusinessMembershipStatus.ACTIVE) continue;

      for (const permission of membership.permissions) {
        // The mirror of the guard above, closing the other direction: a
        // PLATFORM permission attached to a membership. Less dangerous —
        // `resolveTenantKey` already throws for `all`, `User`, `Role`,
        // `AuditLog` and `QueueJob`, so most of it fails closed on its own —
        // but "most" is not a guarantee, and a throw here would take out every
        // request for that account rather than dropping one rule.
        if (permission.scope !== RoleScope.BUSINESS) continue;

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
