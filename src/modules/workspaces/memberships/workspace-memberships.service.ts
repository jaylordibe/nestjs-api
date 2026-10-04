import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../../common/audit/audit.service';
import {
  taggedSubject,
  type AppAbility,
} from '../../../common/authorization/app-ability';
import { buildOrderBy } from '../../../common/dto/meta-query.dto';
import { PaginationMeta } from '../../../common/dto/paginated-response.dto';
import { WorkspaceMembershipStatus } from '../../../common/enums/workspace-membership-status.enum';
import { SeededRoleName } from '../../../common/enums/seeded-role-name.enum';
import { Errors } from '../../../common/errors/errors';
import { buildAuditSnapshot } from '../../../common/util/audit-snapshot.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { AbilityScopedQueryService } from '../../authorization/ability-scoped-query.service';
import { WorkspaceOwnershipPolicy } from '../workspace-ownership.policy';
import { WorkspaceRoleAssignmentPolicy } from '../workspace-role-assignment.policy';
import { PermissionCheckService } from '../../authorization/permission-check.service';
import { PermissionLoaderService } from '../../authorization/permission-loader.service';
import { AddWorkspaceMembershipDto } from './dto/add-workspace-membership.dto';
import { WorkspaceMembershipQueryDto } from './dto/workspace-membership-query.dto';
import type { WorkspaceMembershipRow } from './dto/workspace-membership-response.dto';
import { ChangeMembershipRoleDto } from './dto/change-membership-role.dto';
import { UpdateWorkspaceMembershipDto } from './dto/update-workspace-membership.dto';

const MEMBERSHIP_INCLUDE = {
  user: { select: { id: true, email: true, firstName: true, lastName: true } },
  role: { select: { id: true, name: true, description: true, rank: true } },
} as const;

/**
 * What the membership row said about a tenure, just before it was overwritten.
 *
 * The index signature is what makes this assignable to Prisma's
 * `InputJsonObject` — an interface without one is not, and this value's only
 * destination is `audit_logs.metadata`.
 */
export interface MembershipTenureSnapshot {
  [field: string]: string | null;
  status: string;
  roleName: string;
  joinedAt: string;
  endedAt: string | null;
}

/**
 * Freezes the tenure a re-join is about to overwrite, for the audit trail.
 *
 * `WorkspaceMembership` holds ONE row per (workspace, user) forever, so re-joining
 * rewrites `joinedAt`, `endedAt`, `status`, and `roleId` in place. That is the
 * deliberate model — see the note on the model in `schema.prisma` — and it means
 * the row is current state, never a ledger. `audit_logs` is the ledger, and this
 * is what it needs from the row before the update lands.
 *
 * Dates become ISO strings because the value goes into a `Json` column.
 */
export function describeTenure(previous: {
  status: string;
  joinedAt: Date;
  endedAt: Date | null;
  role: { name: string };
}): MembershipTenureSnapshot {
  return {
    status: previous.status,
    roleName: previous.role.name,
    joinedAt: previous.joinedAt.toISOString(),
    endedAt: previous.endedAt?.toISOString() ?? null,
  };
}

// `User` is soft-deletable, and the `prisma.scoped` extension only filters
// TOP-LEVEL reads — a nested `include` of a soft-deleted user would still
// return it. Prisma offers no `where` on a to-one include, so the deleted user
// is excluded by filtering the PARENT rows here. Every roster query composes
// this, INCLUDING the ones behind a mutation: a membership whose account has
// been erased must not be quietly editable through a route that can no longer
// display it.
const MEMBERSHIP_OF_LIVE_USER = { user: { deletedAt: null } } as const;

// …and the workspace must be live too.
//
// Not redundant with the grant loader's identical filter, which only stops
// WORKSPACE-scoped grants. The intrinsic `read WorkspaceMembership (own)` that
// every authenticated caller holds is PLATFORM-scoped and conditioned on
// `userId` alone, so it survives a workspace being soft-deleted — without this,
// a member could still read their own membership row, and the notes staff
// wrote on it, in a workspace nobody can see any more.
const MEMBERSHIP_OF_LIVE_WORKSPACE = {
  workspace: { deletedAt: null },
} as const;

@Injectable()
export class WorkspaceMembershipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly abilityScopedQueryService: AbilityScopedQueryService,
    private readonly permissionCheckService: PermissionCheckService,
    private readonly permissionLoaderService: PermissionLoaderService,
    private readonly workspaceOwnershipPolicy: WorkspaceOwnershipPolicy,
    private readonly workspaceRoleAssignmentPolicy: WorkspaceRoleAssignmentPolicy,
  ) {}

  /**
   * Adds someone who already has an account to a workspace.
   *
   * `PermissionsGuard` has already proven the caller may create a membership in
   * THIS workspace. What it cannot know is the RANK of the role being handed
   * out — a guard sees a subject type, not a role id — so the escalation
   * ceiling is enforced here.
   *
   * Re-joining is an UPDATE, never an INSERT. `@@unique([workspaceId, userId])`
   * is unconditional, so someone who previously left already owns a row; the
   * lifecycle moves it back to ACTIVE rather than creating a second one.
   */
  async add(
    workspaceId: string,
    dto: AddWorkspaceMembershipDto,
    ability: AppAbility,
    actorId: string,
  ): Promise<WorkspaceMembershipRow> {
    const targetUser = await this.prisma.scoped.user.findFirst({
      where: { email: dto.email },
      select: { id: true },
    });
    if (!targetUser) {
      throw Errors.resourceNotFound('User');
    }

    const targetRole =
      await this.workspaceRoleAssignmentPolicy.loadAssignableRole(dto.roleId);
    // Both bounds: a caller without `assignRole` may only hand out a
    // non-privileged role, and a caller WITH it is still capped at their own
    // rank. The ceiling alone let a manager appoint a peer manager, because
    // rank 40 is not greater than rank 40.
    await this.workspaceRoleAssignmentPolicy.assertMayAssign(
      workspaceId,
      actorId,
      targetRole,
      ability,
      targetUser.id,
    );

    // `notes` is a staff annotation. Accepting it from a caller who may create
    // a membership but not update one would be a write they could not perform
    // through the field's own endpoint.
    const mayAnnotate = ability.can(
      'update',
      taggedSubject('WorkspaceMembership', {
        workspaceId,
        userId: targetUser.id,
      }),
    );
    if (dto.notes !== undefined && !mayAnnotate) {
      throw Errors.permissionDenied('update', 'WorkspaceMembership');
    }
    // Past this point `dto.notes` is undefined whenever `mayAnnotate` is false,
    // so the writes below could pass it through unguarded. They keep the
    // `mayAnnotate ?` ternary anyway: it is one token of defence-in-depth
    // against the throw above being weakened later, and it states the rule at
    // the place the value is written rather than only where it is validated.

    const now = new Date();
    const { membership, previousTenure } = await this.prisma.$transaction(
      async (transaction) => {
        // User row, then workspace row — the order in `row-lock.util.ts`. The
        // target was resolved by email OUTSIDE this transaction, so without the
        // re-read a deletion or deactivation committing in between would leave an
        // ACTIVE membership — possibly an owner one — pointing at an account that
        // can never use it.
        await this.workspaceOwnershipPolicy.assertUserMayHoldActiveMembership(
          transaction,
          targetUser.id,
        );
        await this.workspaceOwnershipPolicy.lockWorkspace(
          transaction,
          workspaceId,
        );

        const existing = await transaction.workspaceMembership.findUnique({
          where: { workspaceId_userId: { workspaceId, userId: targetUser.id } },
          select: {
            id: true,
            status: true,
            joinedAt: true,
            endedAt: true,
            role: { select: { name: true } },
          },
        });

        if (existing) {
          const existingStatus = existing.status as WorkspaceMembershipStatus;
          if (existingStatus !== WorkspaceMembershipStatus.LEFT) {
            throw Errors.resourceConflict(
              'That person already has a membership in this workspace',
            );
          }
          // Re-joining after leaving. `joinedAt` is reset because it records the
          // start of the CURRENT tenure — preserving the original would claim a
          // continuity of membership that did not happen. The tenure being
          // overwritten is captured below and audited, because the audit trail is
          // where this template keeps membership history.
          const rejoined = await transaction.workspaceMembership.update({
            where: { id: existing.id },
            data: {
              roleId: targetRole.id,
              status: WorkspaceMembershipStatus.ACTIVE,
              joinedAt: now,
              endedAt: null,
              notes: mayAnnotate ? dto.notes : undefined,
              updatedBy: actorId,
            },
            include: MEMBERSHIP_INCLUDE,
          });
          return {
            membership: rejoined,
            previousTenure: describeTenure(existing),
          };
        }

        const created = await transaction.workspaceMembership.create({
          data: {
            workspaceId,
            userId: targetUser.id,
            roleId: targetRole.id,
            status: WorkspaceMembershipStatus.ACTIVE,
            joinedAt: now,
            invitedBy: actorId,
            notes: mayAnnotate ? dto.notes : undefined,
            createdBy: actorId,
            updatedBy: actorId,
          },
          include: MEMBERSHIP_INCLUDE,
        });
        return { membership: created, previousTenure: null };
      },
    );

    await this.permissionLoaderService.invalidateUser(targetUser.id);
    await this.auditService.record({
      action: 'workspace_membership.added',
      actorId,
      targetUserId: targetUser.id,
      metadata: {
        workspaceId,
        membershipId: membership.id,
        roleId: targetRole.id,
        roleName: targetRole.name,
        // The membership ROW only ever describes the current tenure, so a
        // re-join silently overwrites the previous one. This is where the
        // overwritten tenure survives.
        isRejoin: previousTenure !== null,
        previousTenure,
      },
    });
    return membership;
  }

  /**
   * The roster.
   *
   * Scoped through `AbilityScopedQueryService`, NOT by `workspaceId` alone. That
   * matters for any role without a workspace-scoped `read WorkspaceMembership`:
   * it holds only the intrinsic ownership-scoped one, so this query returns
   * exactly one row — their own — while roster readers see the whole list.
   * Filtering by tenant alone would hand every such member the full roster.
   */
  async findPaginated(
    workspaceId: string,
    query: WorkspaceMembershipQueryDto,
    ability: AppAbility,
  ): Promise<{ data: WorkspaceMembershipRow[]; meta: PaginationMeta }> {
    const { page, perPage } = query;
    const where = this.abilityScopedQueryService.buildWhereOrEmpty(
      ability,
      'read',
      'WorkspaceMembership',
      {
        workspaceId,
        status: query.status ?? WorkspaceMembershipStatus.ACTIVE,
        ...MEMBERSHIP_OF_LIVE_USER,
        ...MEMBERSHIP_OF_LIVE_WORKSPACE,
      },
    );

    const [data, total] = await this.prisma.$transaction([
      this.prisma.workspaceMembership.findMany({
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
      this.prisma.workspaceMembership.count({ where }),
    ]);
    return {
      data,
      meta: { page, perPage, total, totalPages: Math.ceil(total / perPage) },
    };
  }

  async findById(
    workspaceId: string,
    membershipId: string,
    ability: AppAbility,
  ): Promise<WorkspaceMembershipRow> {
    const membership = await this.prisma.workspaceMembership.findFirst({
      where: this.abilityScopedQueryService.buildWhereOrEmpty(
        ability,
        'read',
        'WorkspaceMembership',
        {
          id: membershipId,
          workspaceId,
          ...MEMBERSHIP_OF_LIVE_USER,
          ...MEMBERSHIP_OF_LIVE_WORKSPACE,
        },
      ),
      include: MEMBERSHIP_INCLUDE,
    });
    if (!membership) {
      // 404 rather than 403: the caller cannot read this row, and confirming it
      // exists would leak the roster to anyone who can guess an id.
      throw Errors.resourceNotFound('Workspace membership');
    }
    return membership;
  }

  /** Staff annotation only. Role, suspension, and ending live elsewhere. */
  async update(
    workspaceId: string,
    membershipId: string,
    dto: UpdateWorkspaceMembershipDto,
    ability: AppAbility,
    actorId: string,
  ): Promise<WorkspaceMembershipRow> {
    const existing = await this.findById(workspaceId, membershipId, ability);
    this.assertMayActOn(ability, 'update', existing);

    const membership = await this.prisma.workspaceMembership.update({
      where: { id: membershipId },
      data: { notes: dto.notes, updatedBy: actorId },
      include: MEMBERSHIP_INCLUDE,
    });

    await this.auditService.record({
      action: 'workspace_membership.updated',
      actorId,
      targetUserId: membership.userId,
      metadata: { workspaceId, membershipId },
    });
    return membership;
  }

  /**
   * Changes a member's role.
   *
   * Three invariants, all enforced under a workspace-row lock so concurrent
   * writes cannot interleave between a check and its write:
   *   1. the target role is workspace-scoped and code-owned;
   *   2. the rank ceiling — you may not grant, or act upon, a role above your
   *      own;
   *   3. the last-owner invariant — demoting the final active owner is refused.
   */
  async changeRole(
    workspaceId: string,
    membershipId: string,
    dto: ChangeMembershipRoleDto,
    ability: AppAbility,
    actorId: string,
  ): Promise<WorkspaceMembershipRow> {
    const visible = await this.findById(workspaceId, membershipId, ability);
    this.assertMayActOn(ability, 'assignRole', visible);

    const targetRole =
      await this.workspaceRoleAssignmentPolicy.loadAssignableRole(dto.roleId);
    const actorRank = await this.workspaceRoleAssignmentPolicy.assertMayAssign(
      workspaceId,
      actorId,
      targetRole,
      ability,
    );

    const membership = await this.prisma.$transaction(async (transaction) => {
      // A role change is an owner-creation path whenever the new role is
      // WORKSPACE_OWNER, so it takes the target's user lock like every other one.
      // `visible` was read before this transaction opened.
      await this.workspaceOwnershipPolicy.assertUserMayHoldActiveMembership(
        transaction,
        visible.userId,
      );
      await this.workspaceOwnershipPolicy.lockWorkspace(
        transaction,
        workspaceId,
      );

      const existing = await transaction.workspaceMembership.findFirst({
        where: { id: membershipId, workspaceId },
        include: { role: { select: { name: true, rank: true } } },
      });
      if (!existing) {
        throw Errors.resourceNotFound('Workspace membership');
      }

      // You may not act upon someone who outranks you, either — otherwise an
      // admin could demote the owner by "assigning" them a lower role.
      this.workspaceRoleAssignmentPolicy.assertRankPermits(
        actorRank,
        existing.role.rank,
      );

      // DB columns are plain `String`; cast at the boundary before comparing
      // against the TS enum (`no-unsafe-enum-comparison`).
      const isDemotingAnOwner =
        (existing.role.name as SeededRoleName) ===
          SeededRoleName.WORKSPACE_OWNER &&
        (targetRole.name as SeededRoleName) !== SeededRoleName.WORKSPACE_OWNER;
      if (isDemotingAnOwner) {
        await this.workspaceOwnershipPolicy.assertAnotherActiveOwnerExists(
          transaction,
          workspaceId,
          membershipId,
        );
      }

      return transaction.workspaceMembership.update({
        where: { id: membershipId },
        data: { roleId: targetRole.id, updatedBy: actorId },
        include: MEMBERSHIP_INCLUDE,
      });
    });

    await this.permissionLoaderService.invalidateUser(membership.userId);
    await this.auditService.record({
      action: 'workspace_membership.role_changed',
      actorId,
      targetUserId: membership.userId,
      metadata: {
        workspaceId,
        membershipId,
        roleId: targetRole.id,
        roleName: targetRole.name,
      },
    });
    return membership;
  }

  /** Withdraws access without ending the relationship. Reversible. */
  async suspend(
    workspaceId: string,
    membershipId: string,
    ability: AppAbility,
    actorId: string,
  ): Promise<WorkspaceMembershipRow> {
    return this.transition(workspaceId, membershipId, ability, actorId, {
      auditAction: 'workspace_membership.suspended',
      requiredAction: 'suspend',
      from: WorkspaceMembershipStatus.ACTIVE,
      to: WorkspaceMembershipStatus.SUSPENDED,
      // Suspending the last owner leaves the workspace with nobody who can
      // administer it — the same outcome as removing them, so the same refusal.
      protectsLastOwner: true,
      data: {},
    });
  }

  async reactivate(
    workspaceId: string,
    membershipId: string,
    ability: AppAbility,
    actorId: string,
  ): Promise<WorkspaceMembershipRow> {
    return this.transition(workspaceId, membershipId, ability, actorId, {
      auditAction: 'workspace_membership.reactivated',
      requiredAction: 'suspend',
      from: WorkspaceMembershipStatus.SUSPENDED,
      to: WorkspaceMembershipStatus.ACTIVE,
      protectsLastOwner: false,
      data: {},
    });
  }

  /**
   * Ends a membership.
   *
   * The row survives — `@@unique([workspaceId, userId])` depends on it — moving
   * to LEFT with `endedAt` stamped. `DELETE` is the HTTP verb because that is
   * what the operation means to a client; the storage decision is ours, not
   * theirs.
   *
   * The surviving row records the tenure that just ended, and keeps doing so
   * only until the person re-joins on it. The durable record of this transition
   * is the `workspace_membership.ended` audit event, which carries a full
   * snapshot — see the note on `WorkspaceMembership` in `schema.prisma`.
   */
  async remove(
    workspaceId: string,
    membershipId: string,
    ability: AppAbility,
    actorId: string,
  ): Promise<void> {
    const existing = await this.findById(workspaceId, membershipId, ability);
    this.assertMayActOn(ability, 'delete', existing);

    await this.transition(workspaceId, membershipId, ability, actorId, {
      auditAction: 'workspace_membership.ended',
      requiredAction: 'delete',
      // Reachable from every remaining live state; `transition` still refuses
      // a membership that has already ended.
      from: null,
      to: WorkspaceMembershipStatus.LEFT,
      protectsLastOwner: true,
      data: { endedAt: new Date() },
    });
  }

  /**
   * Moves ownership of a workspace to another active member.
   *
   * Atomic and explicit. The acting owner is demoted to WORKSPACE_ADMIN in the
   * same transaction that promotes the target, so the workspace passes through
   * no state with two owners or none — and because both writes are under the
   * workspace-row lock, two concurrent transfers cannot interleave into an
   * ownerless workspace.
   *
   * Deliberately NOT reachable through `changeRole`: promoting someone to owner
   * there would require the actor to hold rank 100, which only an owner does,
   * and would then leave TWO owners rather than transferring. Appointing a
   * co-owner is the `changeRole` path; handing over is this one.
   */
  async transferOwnership(
    workspaceId: string,
    membershipId: string,
    ability: AppAbility,
    actorId: string,
  ): Promise<WorkspaceMembershipRow> {
    const [ownerRole, adminRole] = await Promise.all([
      this.loadSeededWorkspaceRole(SeededRoleName.WORKSPACE_OWNER),
      this.loadSeededWorkspaceRole(SeededRoleName.WORKSPACE_ADMIN),
    ]);

    // Whose user row to lock, resolved before the transaction so the locks can
    // be taken in the documented order. Safe to read early precisely because it
    // is the one field of a membership that never changes: `userId` IS the row's
    // identity, so a concurrent write cannot move this membership to somebody
    // else. Everything else about the row is re-read under the lock below.
    const visibleTarget = await this.findById(
      workspaceId,
      membershipId,
      ability,
    );
    const incomingOwnerUserId = visibleTarget.userId;

    const membership = await this.prisma.$transaction(async (transaction) => {
      // The incoming owner's user row, then the workspace row. The target is
      // read below with a live-user filter, but a filter is not a lock: without
      // this, a deletion committing between that read and the promotion hands
      // the workspace its only owner on a dead account.
      await this.workspaceOwnershipPolicy.assertUserMayHoldActiveMembership(
        transaction,
        incomingOwnerUserId,
      );
      await this.workspaceOwnershipPolicy.lockWorkspace(
        transaction,
        workspaceId,
      );

      const target = await transaction.workspaceMembership.findFirst({
        where: {
          id: membershipId,
          workspaceId,
          ...MEMBERSHIP_OF_LIVE_USER,
          ...MEMBERSHIP_OF_LIVE_WORKSPACE,
        },
        select: { id: true, userId: true, status: true },
      });
      if (!target) {
        throw Errors.resourceNotFound('Workspace membership');
      }
      const targetStatus = target.status as WorkspaceMembershipStatus;
      if (targetStatus !== WorkspaceMembershipStatus.ACTIVE) {
        throw Errors.membershipNotActive(targetStatus);
      }
      if (target.userId === actorId) {
        throw Errors.resourceConflict(
          'You already own this workspace; transfer it to somebody else',
        );
      }

      // Demote every CURRENT active owner, not merely the caller's own row.
      //
      // Keying the demotion off the actor was wrong for the one case where the
      // actor is not the owner: a platform admin holds `manage all` and no
      // membership, so nothing was demoted and the workspace came out of a
      // "transfer" with TWO owners — while the audit line claimed ownership had
      // moved. Demoting the incumbent makes the actor-is-owner case fall out as
      // a special case of the same rule rather than being the only one handled.
      const outgoingOwners = await transaction.workspaceMembership.findMany({
        where: {
          workspaceId,
          status: WorkspaceMembershipStatus.ACTIVE,
          roleId: ownerRole.id,
          id: { not: target.id },
        },
        select: { id: true, userId: true },
      });
      if (outgoingOwners.length > 0) {
        await transaction.workspaceMembership.updateMany({
          where: { id: { in: outgoingOwners.map((owner) => owner.id) } },
          data: { roleId: adminRole.id, updatedBy: actorId },
        });
      }

      const promoted = await transaction.workspaceMembership.update({
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
      action: 'workspace_membership.ownership_transferred',
      actorId,
      targetUserId: promoted.userId,
      metadata: { workspaceId, membershipId, demotedUserIds },
    });
    return promoted;
  }

  // ── shared lifecycle machinery ─────────────────────────────────────────

  /**
   * The one code path every status change goes through.
   *
   * Suspension, reactivation, and ending differ only in which states they move
   * between, which permission they demand, and whether they can orphan a
   * workspace. Writing them as three near-identical transactions is how the
   * last-owner check ends up present in two of them and forgotten in the third.
   */
  private async transition(
    workspaceId: string,
    membershipId: string,
    ability: AppAbility,
    actorId: string,
    options: {
      auditAction: string;
      requiredAction: 'suspend' | 'delete';
      from: WorkspaceMembershipStatus | null;
      to: WorkspaceMembershipStatus;
      protectsLastOwner: boolean;
      data: Prisma.WorkspaceMembershipUpdateInput;
    },
  ): Promise<WorkspaceMembershipRow> {
    const visible = await this.findById(workspaceId, membershipId, ability);
    this.assertMayActOn(ability, options.requiredAction, visible);

    const actorRank = await this.workspaceRoleAssignmentPolicy.resolveActorRank(
      workspaceId,
      actorId,
      ability,
    );

    const membership = await this.prisma.$transaction(async (transaction) => {
      // Only when the transition ENDS in ACTIVE. Reactivating a suspended owner
      // re-creates an owner, so it races account deletion exactly the way a
      // promotion does; suspending or ending a membership removes authority and
      // cannot strand anything on a dead account.
      if (options.to === WorkspaceMembershipStatus.ACTIVE) {
        await this.workspaceOwnershipPolicy.assertUserMayHoldActiveMembership(
          transaction,
          visible.userId,
        );
      }
      await this.workspaceOwnershipPolicy.lockWorkspace(
        transaction,
        workspaceId,
      );

      const existing = await transaction.workspaceMembership.findFirst({
        where: { id: membershipId, workspaceId },
        include: { role: { select: { name: true, rank: true } } },
      });
      if (!existing) {
        throw Errors.resourceNotFound('Workspace membership');
      }

      // You may not act upon someone who outranks you.
      this.workspaceRoleAssignmentPolicy.assertRankPermits(
        actorRank,
        existing.role.rank,
      );

      const currentStatus = existing.status as WorkspaceMembershipStatus;
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
          SeededRoleName.WORKSPACE_OWNER &&
        currentStatus === WorkspaceMembershipStatus.ACTIVE;
      if (options.protectsLastOwner && isActiveOwner) {
        await this.workspaceOwnershipPolicy.assertAnotherActiveOwnerExists(
          transaction,
          workspaceId,
          membershipId,
        );
      }

      return transaction.workspaceMembership.update({
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
        workspaceId,
        membershipId,
        snapshot: buildAuditSnapshot(membership),
      },
    });
    return membership;
  }

  // ── invariants ─────────────────────────────────────────────────────────
  //
  // The ownership rule lives in `WorkspaceOwnershipPolicy` and the assignment
  // rules in `WorkspaceRoleAssignmentPolicy`, both injected above. Neither is
  // restated here: account deletion enforces the same ownership rule from the
  // USER side, and invitations enforce the same assignment rules from the
  // INVITE side. The phantom-owner defect that prompted this was precisely one
  // copy of the ownership query forgetting a clause the others remembered.

  private async loadSeededWorkspaceRole(name: SeededRoleName) {
    // `findUniqueOrThrow`, not `findFirst`: `roles.name` is a real full unique
    // index, and a seeded role missing from the database is a boot-integrity
    // failure that should surface loudly rather than as a 404.
    return this.prisma.role.findUniqueOrThrow({
      where: { name },
      select: { id: true, name: true, rank: true },
    });
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

  // Object-level authorization, evaluated against the REAL row rather than the
  // subject type — which is all the guard could check before the record was
  // loaded.
  private assertMayActOn(
    ability: AppAbility,
    action: 'update' | 'assignRole' | 'suspend' | 'delete',
    membership: WorkspaceMembershipRow,
  ): void {
    this.permissionCheckService.assertCan(
      ability,
      action,
      'WorkspaceMembership',
      {
        id: membership.id,
        workspaceId: membership.workspaceId,
        userId: membership.userId,
      },
    );
  }
}
