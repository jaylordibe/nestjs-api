import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../../common/audit/audit.service';
import {
  taggedSubject,
  type AppAbility,
} from '../../../common/authorization/app-ability';
import { buildOrderBy } from '../../../common/dto/meta-query.dto';
import { PaginationMeta } from '../../../common/dto/paginated-response.dto';
import { BusinessInvitationStatus } from '../../../common/enums/business-invitation-status.enum';
import { BusinessMembershipStatus } from '../../../common/enums/business-membership-status.enum';
import { RoleScope } from '../../../common/enums/role-scope.enum';
import { SeededRoleName } from '../../../common/enums/seeded-role-name.enum';
import { Errors } from '../../../common/errors/errors';
import { buildAuditSnapshot } from '../../../common/util/audit-snapshot.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { AbilityScopedQueryService } from '../../authorization/ability-scoped-query.service';
import { PermissionCheckService } from '../../authorization/permission-check.service';
import { PermissionLoaderService } from '../../authorization/permission-loader.service';
import { AddBusinessMembershipDto } from './dto/add-business-membership.dto';
import { BusinessMembershipQueryDto } from './dto/business-membership-query.dto';
import type { BusinessMembershipRow } from './dto/business-membership-response.dto';
import { ChangeMembershipRoleDto } from './dto/change-membership-role.dto';
import { UpdateBusinessMembershipDto } from './dto/update-business-membership.dto';

const MEMBERSHIP_INCLUDE = {
  user: { select: { id: true, email: true, firstName: true, lastName: true } },
  role: { select: { id: true, name: true, description: true, rank: true } },
} as const;

// `User` is soft-deletable, and the `prisma.scoped` extension only filters
// TOP-LEVEL reads — a nested `include` of a soft-deleted user would still
// return it. Prisma offers no `where` on a to-one include, so the deleted user
// is excluded by filtering the PARENT rows here. Every roster query composes
// this, INCLUDING the ones behind a mutation: a membership whose account has
// been erased must not be quietly editable through a route that can no longer
// display it.
const MEMBERSHIP_OF_LIVE_USER = { user: { deletedAt: null } } as const;

// …and the business must be live too.
//
// Not redundant with the grant loader's identical filter, which only stops
// BUSINESS-scoped grants. The intrinsic `read BusinessMembership (own)` that
// every authenticated caller holds is PLATFORM-scoped and conditioned on
// `userId` alone, so it survives a business being soft-deleted — without this,
// a member could still read their own membership row, and the notes staff
// wrote on it, in a business nobody can see any more.
const MEMBERSHIP_OF_LIVE_BUSINESS = {
  business: { deletedAt: null },
} as const;

// A platform admin (`manage all`) has no rank to be bounded by.
//
// `null` rather than a sentinel number, so that "unbounded" and "rank not
// found" can never be the same value. A numeric sentinel invites being used as
// a FALLBACK — and a rank ceiling that defaults to infinity when the lookup
// misses is not a ceiling.
const UNBOUNDED_RANK = null;

@Injectable()
export class BusinessMembershipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly abilityScopedQueryService: AbilityScopedQueryService,
    private readonly permissionCheckService: PermissionCheckService,
    private readonly permissionLoaderService: PermissionLoaderService,
  ) {}

  /**
   * Adds someone who already has an account to a business.
   *
   * `PermissionsGuard` has already proven the caller may create a membership in
   * THIS business. What it cannot know is the RANK of the role being handed
   * out — a guard sees a subject type, not a role id — so the escalation
   * ceiling is enforced here.
   *
   * Re-joining is an UPDATE, never an INSERT. `@@unique([businessId, userId])`
   * is unconditional, so someone who previously left already owns a row; the
   * lifecycle moves it back to ACTIVE rather than creating a second one.
   */
  async add(
    businessId: string,
    dto: AddBusinessMembershipDto,
    ability: AppAbility,
    actorId: string,
  ): Promise<BusinessMembershipRow> {
    const targetUser = await this.prisma.scoped.user.findFirst({
      where: { email: dto.email },
      select: { id: true },
    });
    if (!targetUser) {
      throw Errors.resourceNotFound('User');
    }

    const targetRole = await this.loadAssignableBusinessRole(dto.roleId);
    const actorRank = await this.resolveActorRank(businessId, actorId, ability);
    this.assertRankPermits(actorRank, targetRole.rank);

    // `notes` is a staff annotation. Accepting it from a caller who may create
    // a membership but not update one would be a write they could not perform
    // through the field's own endpoint.
    const mayAnnotate = ability.can(
      'update',
      taggedSubject('BusinessMembership', {
        businessId,
        userId: targetUser.id,
      }),
    );
    if (dto.notes !== undefined && !mayAnnotate) {
      throw Errors.permissionDenied('update', 'BusinessMembership');
    }
    // Past this point `dto.notes` is undefined whenever `mayAnnotate` is false,
    // so the writes below could pass it through unguarded. They keep the
    // `mayAnnotate ?` ternary anyway: it is one token of defence-in-depth
    // against the throw above being weakened later, and it states the rule at
    // the place the value is written rather than only where it is validated.

    const now = new Date();
    const membership = await this.prisma.$transaction(async (transaction) => {
      await this.lockBusiness(transaction, businessId);

      const existing = await transaction.businessMembership.findUnique({
        where: { businessId_userId: { businessId, userId: targetUser.id } },
        select: { id: true, status: true },
      });

      if (existing) {
        const existingStatus = existing.status as BusinessMembershipStatus;
        if (existingStatus !== BusinessMembershipStatus.LEFT) {
          throw Errors.resourceConflict(
            'That person already has a membership in this business',
          );
        }
        // Re-joining after leaving. `joinedAt` is reset because it records the
        // start of the CURRENT stint — preserving the original would claim a
        // continuity of membership that did not happen.
        return transaction.businessMembership.update({
          where: { id: existing.id },
          data: {
            roleId: targetRole.id,
            status: BusinessMembershipStatus.ACTIVE,
            joinedAt: now,
            endedAt: null,
            notes: mayAnnotate ? dto.notes : undefined,
            updatedBy: actorId,
          },
          include: MEMBERSHIP_INCLUDE,
        });
      }

      return transaction.businessMembership.create({
        data: {
          businessId,
          userId: targetUser.id,
          roleId: targetRole.id,
          status: BusinessMembershipStatus.ACTIVE,
          joinedAt: now,
          invitedBy: actorId,
          notes: mayAnnotate ? dto.notes : undefined,
          createdBy: actorId,
          updatedBy: actorId,
        },
        include: MEMBERSHIP_INCLUDE,
      });
    });

    await this.permissionLoaderService.invalidateUser(targetUser.id);
    await this.auditService.record({
      action: 'business_membership.added',
      actorId,
      targetUserId: targetUser.id,
      metadata: {
        businessId,
        membershipId: membership.id,
        roleId: targetRole.id,
        roleName: targetRole.name,
      },
    });
    return membership;
  }

  /**
   * The roster.
   *
   * Scoped through `AbilityScopedQueryService`, NOT by `businessId` alone. That
   * matters now that a customer is a membership like any other: a
   * BUSINESS_CUSTOMER holds no business-scoped `read BusinessMembership`, only
   * the intrinsic ownership-scoped one, so this query returns them exactly one
   * row — their own — while staff see the whole list. Filtering by tenant alone
   * would hand every customer the full roster.
   */
  async findPaginated(
    businessId: string,
    query: BusinessMembershipQueryDto,
    ability: AppAbility,
  ): Promise<{ data: BusinessMembershipRow[]; meta: PaginationMeta }> {
    const { page, perPage } = query;
    const where = this.abilityScopedQueryService.buildWhereOrEmpty(
      ability,
      'read',
      'BusinessMembership',
      {
        businessId,
        status: query.status ?? BusinessMembershipStatus.ACTIVE,
        ...MEMBERSHIP_OF_LIVE_USER,
        ...MEMBERSHIP_OF_LIVE_BUSINESS,
      },
    );

    const [data, total] = await this.prisma.$transaction([
      this.prisma.businessMembership.findMany({
        where,
        include: MEMBERSHIP_INCLUDE,
        orderBy: buildOrderBy(
          query,
          ['createdAt', 'updatedAt', 'joinedAt'] as const,
          'createdAt',
        ),
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.businessMembership.count({ where }),
    ]);
    return {
      data,
      meta: { page, perPage, total, totalPages: Math.ceil(total / perPage) },
    };
  }

  async findById(
    businessId: string,
    membershipId: string,
    ability: AppAbility,
  ): Promise<BusinessMembershipRow> {
    const membership = await this.prisma.businessMembership.findFirst({
      where: this.abilityScopedQueryService.buildWhereOrEmpty(
        ability,
        'read',
        'BusinessMembership',
        {
          id: membershipId,
          businessId,
          ...MEMBERSHIP_OF_LIVE_USER,
          ...MEMBERSHIP_OF_LIVE_BUSINESS,
        },
      ),
      include: MEMBERSHIP_INCLUDE,
    });
    if (!membership) {
      // 404 rather than 403: the caller cannot read this row, and confirming it
      // exists would leak the roster to anyone who can guess an id.
      throw Errors.resourceNotFound('Business membership');
    }
    return membership;
  }

  /** Staff annotation only. Role, suspension, and ending live elsewhere. */
  async update(
    businessId: string,
    membershipId: string,
    dto: UpdateBusinessMembershipDto,
    ability: AppAbility,
    actorId: string,
  ): Promise<BusinessMembershipRow> {
    const existing = await this.findById(businessId, membershipId, ability);
    this.assertMayActOn(ability, 'update', existing);

    const membership = await this.prisma.businessMembership.update({
      where: { id: membershipId },
      data: { notes: dto.notes, updatedBy: actorId },
      include: MEMBERSHIP_INCLUDE,
    });

    await this.auditService.record({
      action: 'business_membership.updated',
      actorId,
      targetUserId: membership.userId,
      metadata: { businessId, membershipId },
    });
    return membership;
  }

  /**
   * Changes a member's role.
   *
   * Three invariants, all enforced under a business-row lock so concurrent
   * writes cannot interleave between a check and its write:
   *   1. the target role is business-scoped and code-owned;
   *   2. the rank ceiling — you may not grant, or act upon, a role above your
   *      own;
   *   3. the last-owner invariant — demoting the final active owner is refused.
   */
  async changeRole(
    businessId: string,
    membershipId: string,
    dto: ChangeMembershipRoleDto,
    ability: AppAbility,
    actorId: string,
  ): Promise<BusinessMembershipRow> {
    const visible = await this.findById(businessId, membershipId, ability);
    this.assertMayActOn(ability, 'assignRole', visible);

    const targetRole = await this.loadAssignableBusinessRole(dto.roleId);
    const actorRank = await this.resolveActorRank(businessId, actorId, ability);
    this.assertRankPermits(actorRank, targetRole.rank);

    const membership = await this.prisma.$transaction(async (transaction) => {
      await this.lockBusiness(transaction, businessId);

      const existing = await transaction.businessMembership.findFirst({
        where: { id: membershipId, businessId },
        include: { role: { select: { name: true, rank: true } } },
      });
      if (!existing) {
        throw Errors.resourceNotFound('Business membership');
      }

      // You may not act upon someone who outranks you, either — otherwise an
      // admin could demote the owner by "assigning" them a lower role.
      this.assertRankPermits(actorRank, existing.role.rank);

      // DB columns are plain `String`; cast at the boundary before comparing
      // against the TS enum (`no-unsafe-enum-comparison`).
      const isDemotingAnOwner =
        (existing.role.name as SeededRoleName) ===
          SeededRoleName.BUSINESS_OWNER &&
        (targetRole.name as SeededRoleName) !== SeededRoleName.BUSINESS_OWNER;
      if (isDemotingAnOwner) {
        await this.assertAnotherActiveOwnerExists(
          transaction,
          businessId,
          membershipId,
        );
      }

      return transaction.businessMembership.update({
        where: { id: membershipId },
        data: { roleId: targetRole.id, updatedBy: actorId },
        include: MEMBERSHIP_INCLUDE,
      });
    });

    await this.permissionLoaderService.invalidateUser(membership.userId);
    await this.auditService.record({
      action: 'business_membership.role_changed',
      actorId,
      targetUserId: membership.userId,
      metadata: {
        businessId,
        membershipId,
        roleId: targetRole.id,
        roleName: targetRole.name,
      },
    });
    return membership;
  }

  /** Withdraws access without ending the relationship. Reversible. */
  async suspend(
    businessId: string,
    membershipId: string,
    ability: AppAbility,
    actorId: string,
  ): Promise<BusinessMembershipRow> {
    return this.transition(businessId, membershipId, ability, actorId, {
      auditAction: 'business_membership.suspended',
      requiredAction: 'suspend',
      from: BusinessMembershipStatus.ACTIVE,
      to: BusinessMembershipStatus.SUSPENDED,
      // Suspending the last owner leaves the business with nobody who can
      // administer it — the same outcome as removing them, so the same refusal.
      protectsLastOwner: true,
      data: {},
    });
  }

  async reactivate(
    businessId: string,
    membershipId: string,
    ability: AppAbility,
    actorId: string,
  ): Promise<BusinessMembershipRow> {
    return this.transition(businessId, membershipId, ability, actorId, {
      auditAction: 'business_membership.reactivated',
      requiredAction: 'suspend',
      from: BusinessMembershipStatus.SUSPENDED,
      to: BusinessMembershipStatus.ACTIVE,
      protectsLastOwner: false,
      data: {},
    });
  }

  /**
   * Ends a membership.
   *
   * The row survives — `@@unique([businessId, userId])` depends on it, and the
   * relationship is history worth keeping. `DELETE` is the HTTP verb because
   * that is what the operation means to a client; the storage decision is ours,
   * not theirs.
   */
  async remove(
    businessId: string,
    membershipId: string,
    ability: AppAbility,
    actorId: string,
  ): Promise<void> {
    const existing = await this.findById(businessId, membershipId, ability);
    this.assertMayActOn(ability, 'delete', existing);

    // An INVITED membership is a RESERVATION, not a relationship — the person
    // was invited and never joined. Removing it is a cancellation, so the row
    // is deleted outright and the pending invitation withdrawn with it,
    // freeing the address to be invited again.
    //
    // It cannot go through `transition()`: that writes `status = 'left'` while
    // leaving `joined_at` null, which the `business_memberships_joined_at_check`
    // CHECK refuses — surfacing as a 500 rather than any domain error, since
    // 23514 is not one of the Prisma codes the global filter translates.
    if (
      (existing.status as BusinessMembershipStatus) ===
      BusinessMembershipStatus.INVITED
    ) {
      await this.cancelInvitedMembership(businessId, existing, actorId);
      return;
    }

    await this.transition(businessId, membershipId, ability, actorId, {
      auditAction: 'business_membership.ended',
      requiredAction: 'delete',
      // Reachable from every remaining live state; `transition` still refuses
      // a membership that has already ended.
      from: null,
      to: BusinessMembershipStatus.LEFT,
      protectsLastOwner: true,
      data: { endedAt: new Date() },
    });
  }

  /**
   * Withdraws an invitation that reserved a roster slot.
   *
   * Deletes the placeholder membership and revokes the pending invitation in
   * one transaction, so the roster and the invitation list cannot disagree
   * about whether the person is still expected.
   *
   * An INVITED membership carries no authority and no history worth keeping —
   * it exists only to hold the `(businessId, userId)` slot — so deleting it is
   * correct where ending an ACTIVE membership would destroy real history.
   */
  private async cancelInvitedMembership(
    businessId: string,
    membership: BusinessMembershipRow,
    actorId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await this.lockBusiness(transaction, businessId);

      await transaction.businessMembership.deleteMany({
        where: {
          id: membership.id,
          businessId,
          status: BusinessMembershipStatus.INVITED,
        },
      });

      await transaction.businessInvitation.updateMany({
        where: {
          businessId,
          email: membership.user.email,
          status: BusinessInvitationStatus.PENDING,
        },
        data: {
          status: BusinessInvitationStatus.REVOKED,
          revokedAt: new Date(),
          revokedBy: actorId,
          updatedBy: actorId,
        },
      });
    });

    await this.auditService.record({
      action: 'business_membership.invitation_cancelled',
      actorId,
      targetUserId: membership.userId,
      metadata: { businessId, membershipId: membership.id },
    });
  }

  /**
   * Moves ownership of a business to another active member.
   *
   * Atomic and explicit. The acting owner is demoted to BUSINESS_ADMIN in the
   * same transaction that promotes the target, so the business passes through
   * no state with two owners or none — and because both writes are under the
   * business-row lock, two concurrent transfers cannot interleave into an
   * ownerless business.
   *
   * Deliberately NOT reachable through `changeRole`: promoting someone to owner
   * there would require the actor to hold rank 100, which only an owner does,
   * and would then leave TWO owners rather than transferring. Appointing a
   * co-owner is the `changeRole` path; handing over is this one.
   */
  async transferOwnership(
    businessId: string,
    membershipId: string,
    ability: AppAbility,
    actorId: string,
  ): Promise<BusinessMembershipRow> {
    const [ownerRole, adminRole] = await Promise.all([
      this.loadSeededBusinessRole(SeededRoleName.BUSINESS_OWNER),
      this.loadSeededBusinessRole(SeededRoleName.BUSINESS_ADMIN),
    ]);

    const membership = await this.prisma.$transaction(async (transaction) => {
      await this.lockBusiness(transaction, businessId);

      const target = await transaction.businessMembership.findFirst({
        where: {
          id: membershipId,
          businessId,
          ...MEMBERSHIP_OF_LIVE_USER,
          ...MEMBERSHIP_OF_LIVE_BUSINESS,
        },
        select: { id: true, userId: true, status: true },
      });
      if (!target) {
        throw Errors.resourceNotFound('Business membership');
      }
      const targetStatus = target.status as BusinessMembershipStatus;
      if (targetStatus !== BusinessMembershipStatus.ACTIVE) {
        throw Errors.membershipNotActive(targetStatus);
      }
      if (target.userId === actorId) {
        throw Errors.resourceConflict(
          'You already own this business; transfer it to somebody else',
        );
      }

      // Demote every CURRENT active owner, not merely the caller's own row.
      //
      // Keying the demotion off the actor was wrong for the one case where the
      // actor is not the owner: a platform admin holds `manage all` and no
      // membership, so nothing was demoted and the business came out of a
      // "transfer" with TWO owners — while the audit line claimed ownership had
      // moved. Demoting the incumbent makes the actor-is-owner case fall out as
      // a special case of the same rule rather than being the only one handled.
      const outgoingOwners = await transaction.businessMembership.findMany({
        where: {
          businessId,
          status: BusinessMembershipStatus.ACTIVE,
          roleId: ownerRole.id,
          id: { not: target.id },
        },
        select: { id: true, userId: true },
      });
      if (outgoingOwners.length > 0) {
        await transaction.businessMembership.updateMany({
          where: { id: { in: outgoingOwners.map((owner) => owner.id) } },
          data: { roleId: adminRole.id, updatedBy: actorId },
        });
      }

      const promoted = await transaction.businessMembership.update({
        where: { id: target.id },
        data: { roleId: ownerRole.id, updatedBy: actorId },
        include: MEMBERSHIP_INCLUDE,
      });
      return {
        promoted,
        demotedUserIds: outgoingOwners.map((outgoing) => outgoing.userId),
      };
    });

    // Everyone whose authority changed: the new owner, every demoted owner, and
    // the actor (who may be neither, when a platform admin performs it).
    const { promoted, demotedUserIds } = membership;
    for (const affectedUserId of new Set([
      promoted.userId,
      actorId,
      ...demotedUserIds,
    ])) {
      await this.permissionLoaderService.invalidateUser(affectedUserId);
    }
    await this.auditService.record({
      action: 'business_membership.ownership_transferred',
      actorId,
      targetUserId: promoted.userId,
      metadata: { businessId, membershipId, demotedUserIds },
    });
    return promoted;
  }

  // ── shared lifecycle machinery ─────────────────────────────────────────

  /**
   * The one code path every status change goes through.
   *
   * Suspension, reactivation, and ending differ only in which states they move
   * between, which permission they demand, and whether they can orphan a
   * business. Writing them as three near-identical transactions is how the
   * last-owner check ends up present in two of them and forgotten in the third.
   */
  private async transition(
    businessId: string,
    membershipId: string,
    ability: AppAbility,
    actorId: string,
    options: {
      auditAction: string;
      requiredAction: 'suspend' | 'delete';
      from: BusinessMembershipStatus | null;
      to: BusinessMembershipStatus;
      protectsLastOwner: boolean;
      data: Prisma.BusinessMembershipUpdateInput;
    },
  ): Promise<BusinessMembershipRow> {
    const visible = await this.findById(businessId, membershipId, ability);
    this.assertMayActOn(ability, options.requiredAction, visible);

    const actorRank = await this.resolveActorRank(businessId, actorId, ability);

    const membership = await this.prisma.$transaction(async (transaction) => {
      await this.lockBusiness(transaction, businessId);

      const existing = await transaction.businessMembership.findFirst({
        where: { id: membershipId, businessId },
        include: { role: { select: { name: true, rank: true } } },
      });
      if (!existing) {
        throw Errors.resourceNotFound('Business membership');
      }

      // You may not act upon someone who outranks you.
      this.assertRankPermits(actorRank, existing.role.rank);

      const currentStatus = existing.status as BusinessMembershipStatus;
      // Already in the target state. Reported as a plain conflict rather than
      // MEMBERSHIP_NOT_ACTIVE, because that code carries `details.status` and
      // would otherwise say "not active: active" — a machine-readable code
      // contradicting its own payload, which a client branching on `errorCode`
      // cannot make sense of.
      if (currentStatus === options.to) {
        throw Errors.resourceConflict(
          `That membership is already "${currentStatus}"`,
        );
      }
      if (options.from !== null && currentStatus !== options.from) {
        throw Errors.membershipNotActive(currentStatus);
      }

      const isActiveOwner =
        (existing.role.name as SeededRoleName) ===
          SeededRoleName.BUSINESS_OWNER &&
        currentStatus === BusinessMembershipStatus.ACTIVE;
      if (options.protectsLastOwner && isActiveOwner) {
        await this.assertAnotherActiveOwnerExists(
          transaction,
          businessId,
          membershipId,
        );
      }

      return transaction.businessMembership.update({
        where: { id: membershipId },
        data: { ...options.data, status: options.to, updatedBy: actorId },
        include: MEMBERSHIP_INCLUDE,
      });
    });

    await this.permissionLoaderService.invalidateUser(membership.userId);
    await this.auditService.record({
      action: options.auditAction,
      actorId,
      targetUserId: membership.userId,
      metadata: {
        businessId,
        membershipId,
        snapshot: buildAuditSnapshot(membership),
      },
    });
    return membership;
  }

  // ── invariants ─────────────────────────────────────────────────────────

  /**
   * Serializes every membership mutation for ONE business.
   *
   * The alternative — a Serializable transaction — also produces a correct
   * result, but Postgres reports the loser as a serialization failure and
   * Prisma does not retry it, so a concurrent demotion surfaces to the client
   * as a 500 (`P2034`) rather than a conflict it can act on. An explicit row
   * lock gives deterministic ordering and a real error, with no retry loop.
   *
   * The lock is taken on the BUSINESS row, not the membership row, because the
   * invariant being protected ("at least one active owner") is a property of
   * the business as a whole: two transactions demoting two DIFFERENT owners
   * would never contend on a per-membership lock, and both would observe a
   * count of two.
   */
  private async lockBusiness(
    transaction: Prisma.TransactionClient,
    businessId: string,
  ): Promise<void> {
    await transaction.$queryRaw`SELECT id FROM businesses WHERE id = ${businessId}::uuid FOR UPDATE`;
  }

  private async assertAnotherActiveOwnerExists(
    transaction: Prisma.TransactionClient,
    businessId: string,
    excludingMembershipId: string,
  ): Promise<void> {
    const remainingOwners = await transaction.businessMembership.count({
      where: {
        businessId,
        status: BusinessMembershipStatus.ACTIVE,
        role: { name: SeededRoleName.BUSINESS_OWNER },
        id: { not: excludingMembershipId },
      },
    });
    if (remainingOwners === 0) {
      throw Errors.lastOwnerProtected();
    }
  }

  private async loadAssignableBusinessRole(roleId: string) {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      select: { id: true, name: true, rank: true, scope: true },
    });
    if (!role) {
      throw Errors.resourceNotFound('Role');
    }
    // The write-path half of scope integrity: refuse before any row is
    // touched, with a clean 403. The read-path half — the one that actually
    // bounds authority if this check is ever bypassed — is in `AbilityFactory`.
    if ((role.scope as RoleScope) !== RoleScope.BUSINESS) {
      throw Errors.roleNotAssignable();
    }
    return role;
  }

  private async loadSeededBusinessRole(name: SeededRoleName) {
    // `findUniqueOrThrow`, not `findFirst`: `roles.name` is a real full unique
    // index, and a seeded role missing from the database is a boot-integrity
    // failure that should surface loudly rather than as a 404.
    return this.prisma.role.findUniqueOrThrow({
      where: { name },
      select: { id: true, name: true, rank: true },
    });
  }

  /**
   * The caller's assignment ceiling inside this business.
   *
   * Returns `UNBOUNDED_RANK` for a platform admin (`manage all`) and otherwise
   * the rank of the caller's ACTIVE membership. A caller with no active
   * membership is REFUSED rather than defaulted, because past the `manage all`
   * gate a missing row means they reached this business through a
   * platform-scoped grant without unrestricted authority — so nothing bounds
   * them, and they hold no rank to be measured against.
   *
   * A guard whose whole purpose is to bound authority must never read "I could
   * not find your rank" as "you have no limit". An earlier version of this code
   * did exactly that, and any future platform role holding `assignRole` would
   * have inherited an infinite ceiling in every business on the platform.
   *
   * Note the ACTIVE filter: a suspended owner has rank 100 on paper and no
   * authority in fact.
   */
  private async resolveActorRank(
    businessId: string,
    actorId: string,
    ability: AppAbility,
  ): Promise<number | typeof UNBOUNDED_RANK> {
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

  /**
   * You may grant, or act upon, a role AT OR BELOW your own rank — never above.
   *
   * At-or-below rather than strictly-below is deliberate: a lateral grant is
   * not an escalation (an admin appointing a peer admin gains nothing it did
   * not already have), and strictly-below would make appointing a co-owner
   * impossible, which would in turn make the last-owner error's advice
   * ("appoint another owner first") unreachable. What is forbidden is reaching
   * UP: an admin can never mint an owner.
   */
  private assertRankPermits(
    actorRank: number | typeof UNBOUNDED_RANK,
    targetRank: number,
  ): void {
    if (actorRank === UNBOUNDED_RANK) return;
    if (targetRank > actorRank) {
      throw Errors.roleNotAssignable();
    }
  }

  // Object-level authorization, evaluated against the REAL row rather than the
  // subject type — which is all the guard could check before the record was
  // loaded.
  private assertMayActOn(
    ability: AppAbility,
    action: 'update' | 'assignRole' | 'suspend' | 'delete',
    membership: BusinessMembershipRow,
  ): void {
    this.permissionCheckService.assertCan(
      ability,
      action,
      'BusinessMembership',
      {
        id: membership.id,
        businessId: membership.businessId,
        userId: membership.userId,
      },
    );
  }
}
