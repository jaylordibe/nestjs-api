import { Injectable } from '@nestjs/common';
import {
  taggedSubject,
  type AppAbility,
} from '../../common/authorization/app-ability';
import { BusinessMembershipStatus } from '../../common/enums/business-membership-status.enum';
import { RoleScope } from '../../common/enums/role-scope.enum';
import { SeededRoleName } from '../../common/enums/seeded-role-name.enum';
import { Errors } from '../../common/errors/errors';
import { PrismaService } from '../../prisma/prisma.service';

/** A business role, resolved and validated as assignable. */
export interface AssignableBusinessRole {
  id: string;
  name: string;
  rank: number;
}

/**
 * A platform admin (`manage all`) has no rank to be bounded by.
 *
 * `null` rather than a sentinel number, so that "unbounded" and "rank not
 * found" can never be the same value. A numeric sentinel invites being used as
 * a FALLBACK — and a rank ceiling that defaults to infinity when the lookup
 * misses is not a ceiling.
 */
export const UNBOUNDED_RANK = null;
export type AssignmentCeiling = number | typeof UNBOUNDED_RANK;

/**
 * The roles a caller may hand out WITHOUT holding role-assignment authority.
 *
 * An allowlist, not a denylist, and that direction is the guardrail: a business
 * role added to the catalog tomorrow is privileged by default and has to be
 * named here deliberately to become handable-out. A denylist would silently
 * admit it.
 *
 * These two are the roles that confer no authority over other people —
 * `BUSINESS_MEMBER` reads the business and its roster, `BUSINESS_CUSTOMER` reads
 * only the business. Everything above them can grow, suspend, or re-rank the
 * roster, which is exactly the authority `assignRole` gates.
 */
const NON_PRIVILEGED_BUSINESS_ROLES: readonly SeededRoleName[] = [
  SeededRoleName.BUSINESS_MEMBER,
  SeededRoleName.BUSINESS_CUSTOMER,
];

/**
 * The one place that decides whether a caller may hand out a given role.
 *
 * Two independent bounds, and both are needed:
 *
 *   1. **Authority** — a caller without `assignRole BusinessMembership` may only
 *      choose from `NON_PRIVILEGED_BUSINESS_ROLES`.
 *   2. **Ceiling** — a caller WITH it still cannot exceed their own rank.
 *
 * The rank ceiling alone was not enough, and the gap was not obvious: rank 40 is
 * not GREATER than rank 40, so a `BUSINESS_MANAGER` — who holds
 * `create BusinessMembership` but deliberately not `assignRole` — could appoint
 * a peer manager, and then another, without ever holding the permission that
 * governs handing out roles. The catalog says a manager "can grow the roster but
 * not assign roles"; only the first half of that was true.
 *
 * Shared by memberships and invitations because an invitation IS a role
 * assignment, merely deferred. Enforcing it on one path and not the other means
 * the rule is whichever endpoint the caller picks.
 */
@Injectable()
export class BusinessRoleAssignmentPolicy {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves a role id to a role that may be attached to a membership.
   *
   * The write-path half of scope integrity: refuse before any row is touched,
   * with a clean 403. The read-path half — the one that actually bounds
   * authority if this check is ever bypassed — is in `AbilityFactory`.
   */
  async loadAssignableRole(roleId: string): Promise<AssignableBusinessRole> {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      select: { id: true, name: true, rank: true, scope: true },
    });
    if (!role) {
      throw Errors.resourceNotFound('Role');
    }
    if ((role.scope as RoleScope) !== RoleScope.BUSINESS) {
      throw Errors.roleNotAssignable();
    }
    return { id: role.id, name: role.name, rank: role.rank };
  }

  /**
   * The caller's rank within this business, or `UNBOUNDED_RANK` for a platform
   * admin.
   *
   * A caller with no ACTIVE membership here has no ceiling to compare against
   * and is refused outright rather than defaulted to anything.
   */
  async resolveActorRank(
    businessId: string,
    actorId: string,
    ability: AppAbility,
  ): Promise<AssignmentCeiling> {
    if (ability.can('manage', 'all')) return UNBOUNDED_RANK;

    const actorMembership = await this.prisma.businessMembership.findUnique({
      where: { businessId_userId: { businessId, userId: actorId } },
      select: { status: true, role: { select: { rank: true } } },
    });
    if (
      !actorMembership ||
      (actorMembership.status as BusinessMembershipStatus) !==
        BusinessMembershipStatus.ACTIVE
    ) {
      throw Errors.roleNotAssignable();
    }
    return actorMembership.role.rank;
  }

  assertRankPermits(actorRank: AssignmentCeiling, targetRank: number): void {
    if (actorRank === UNBOUNDED_RANK) return;
    if (targetRank > actorRank) {
      throw Errors.roleNotAssignable();
    }
  }

  /**
   * Both bounds, applied to one role the caller has chosen.
   *
   * Returns the caller's ceiling so a caller that needs it again — to check the
   * role being replaced, say — does not re-query for it.
   */
  async assertMayAssign(
    businessId: string,
    actorId: string,
    role: AssignableBusinessRole,
    ability: AppAbility,
    targetUserId?: string,
  ): Promise<AssignmentCeiling> {
    // An INSTANCE check, never a bare subject type: CASL ignores conditions on
    // a type check, so `can('assignRole', 'BusinessMembership')` answers true
    // for anyone holding the permission in ANY business — including one they
    // are merely a customer of.
    const mayAssignRoles = ability.can(
      'assignRole',
      taggedSubject('BusinessMembership', {
        businessId,
        ...(targetUserId ? { userId: targetUserId } : {}),
      }),
    );
    if (
      !mayAssignRoles &&
      !NON_PRIVILEGED_BUSINESS_ROLES.includes(role.name as SeededRoleName)
    ) {
      throw Errors.roleNotAssignable();
    }

    const actorRank = await this.resolveActorRank(businessId, actorId, ability);
    this.assertRankPermits(actorRank, role.rank);
    return actorRank;
  }
}
