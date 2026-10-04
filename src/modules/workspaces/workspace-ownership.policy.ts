import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WorkspaceMembershipStatus } from '../../common/enums/workspace-membership-status.enum';
import { SeededRoleName } from '../../common/enums/seeded-role-name.enum';
import { Errors } from '../../common/errors/errors';
import {
  lockWorkspaceRow,
  lockWorkspaceRows,
  lockUserRow,
} from '../../common/util/row-lock.util';

/** A live workspace whose only remaining active owner is the user in question. */
export interface SolelyOwnedWorkspace {
  id: string;
  name: string;
}

export interface ClosedWorkspacesResult {
  workspaces: SolelyOwnedWorkspace[];
  /** Every roster member of the closed workspaces — their grants are now stale. */
  affectedUserIds: string[];
}

/**
 * The one place that answers "does this workspace still have an owner?".
 *
 * The invariant — every live workspace has at least one ACTIVE owner whose
 * account is live — is not a membership concern. It is violated just as easily
 * from the USER side: deleting an account silently strands an ACTIVE
 * WORKSPACE_OWNER membership pointing at a dead user. That row is invisible to
 * every roster read (they all filter on a live user), so no workspace-level actor
 * can repair it — `WORKSPACE_ADMIN` holds no `transferOwnership`. Only a platform
 * admin could, and only if somebody noticed.
 *
 * So the rule lives here, injected into both sides, rather than being restated
 * in each. It cannot live in `src/common/` — that is the leaf layer and may not
 * depend on modules — and it must not be duplicated, because the phantom-owner
 * bug this replaces was exactly one copy of the ownership query forgetting one
 * clause the others remembered.
 *
 * Every method takes a `Prisma.TransactionClient`. Checking the invariant
 * outside the transaction that acts on it is the same as not checking it.
 *
 * **Lock order: the user row, then the workspace row.** Both are taken from
 * `src/common/util/row-lock.util.ts`, which is where the order is documented and
 * why. Any mutation that can leave somebody holding — or no longer holding — an
 * ACTIVE owner membership must take BOTH, in that order: the workspace lock alone
 * cannot serialise against an account deletion, because a deletion only knows to
 * lock the workspaces the account ALREADY owns.
 */
@Injectable()
export class WorkspaceOwnershipPolicy {
  /**
   * Serialize every change that could affect a workspace's owner count.
   *
   * The lock is on the WORKSPACE row, not the membership row, because the
   * invariant is a property of the workspace as a whole: two transactions
   * demoting two DIFFERENT owners would never contend on a per-membership lock,
   * and both would observe a count of two.
   *
   * **Never pass an `isolationLevel` to a `$transaction` that calls this.** The
   * reads that follow this lock — the owner count this lock exists to support,
   * and the roster and invitation reads in the paths that reuse it — are correct
   * only under READ COMMITTED, where each statement re-snapshots and therefore
   * sees what the previous lock holder committed. Under REPEATABLE READ the
   * snapshot is fixed at the first statement and this lock raises no
   * serialization error, so the waiter reads pre-lock state and believes it
   * synchronised. The full explanation, including why SERIALIZABLE fails
   * differently, is in `src/common/util/row-lock.util.ts`.
   */
  async lockWorkspace(
    transaction: Prisma.TransactionClient,
    workspaceId: string,
  ): Promise<void> {
    await lockWorkspaceRow(transaction, workspaceId);
  }

  /**
   * The gate on every write that leaves someone with an ACTIVE membership.
   *
   * Locks the target's user row and RE-READS it. Both halves matter, and the
   * re-read is the one that is easy to leave out: a target resolved before the
   * transaction — by email in `add`, by `invitedUserId` in `accept`, by the
   * membership row in `changeRole` — was read without the lock held, so a
   * deletion or deactivation can commit between that read and the write.
   *
   * Any path accepting a `roleId` is a potential owner-creation path, so this is
   * applied to all of them rather than to the ones named "transfer ownership".
   * Getting an ACTIVE owner membership onto a dead account is the failure this
   * prevents, and that row is invisible to every roster read — nobody would find
   * it to repair it.
   *
   * Reports the SAME 404 an unknown user gets. A caller who may add members is
   * not thereby entitled to learn that a particular address belongs to a
   * deactivated account.
   */
  async assertUserMayHoldActiveMembership(
    transaction: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    await lockUserRow(transaction, userId);
    // The raw client: a `$transaction` callback is unscoped, so the soft-delete
    // filter does not apply and `deletedAt` has to be named explicitly.
    const user = await transaction.user.findFirst({
      where: { id: userId, deletedAt: null, isActive: true },
      select: { id: true },
    });
    if (!user) {
      throw Errors.resourceNotFound('User');
    }
  }

  /**
   * Refuse the operation unless the workspace keeps an owner without this
   * membership.
   *
   * `excludingMembershipId` is the membership about to be removed, demoted, or
   * suspended — the count must not include it.
   */
  async assertAnotherActiveOwnerExists(
    transaction: Prisma.TransactionClient,
    workspaceId: string,
    excludingMembershipId: string,
  ): Promise<void> {
    const remainingOwners = await transaction.workspaceMembership.count({
      where: {
        workspaceId,
        id: { not: excludingMembershipId },
        ...ACTIVE_OWNER_OF_USABLE_ACCOUNT,
      },
    });
    if (remainingOwners === 0) {
      throw Errors.lastOwnerProtected();
    }
  }

  /**
   * The live workspaces this user owns alone, resolved under a lock.
   *
   * The lock is taken between the two reads and is not optional: without it,
   * two co-owners deleting their accounts simultaneously each see the other and
   * both proceed, which is the exact outcome the invariant exists to prevent.
   * Folding it in here means no caller can forget it.
   *
   * Two queries rather than one per workspace — the roster grouping is what makes
   * "alone" a set operation instead of an N+1 walk.
   */
  async findSolelyOwnedLiveWorkspaces(
    transaction: Prisma.TransactionClient,
    userId: string,
  ): Promise<SolelyOwnedWorkspace[]> {
    const ownedWorkspaces = await transaction.workspaceMembership.findMany({
      where: {
        userId,
        workspace: { deletedAt: null },
        ...ACTIVE_OWNER,
      },
      select: { workspace: { select: { id: true, name: true } } },
      orderBy: { workspaceId: 'asc' },
    });
    if (ownedWorkspaces.length === 0) {
      return [];
    }

    const ownedWorkspaceIds = ownedWorkspaces.map(
      ({ workspace }) => workspace.id,
    );
    await lockWorkspaceRows(transaction, ownedWorkspaceIds);

    const workspacesWithCoOwner = await transaction.workspaceMembership.groupBy(
      {
        by: ['workspaceId'],
        where: {
          workspaceId: { in: ownedWorkspaceIds },
          // Somebody OTHER than the user being removed, and holding an account
          // that can still sign in. An owner whose account is gone — or switched
          // off — is not an owner.
          userId: { not: userId },
          ...ACTIVE_OWNER_OF_USABLE_ACCOUNT,
        },
      },
    );
    const stillOwnedByAnother = new Set(
      workspacesWithCoOwner.map((group) => group.workspaceId),
    );

    return ownedWorkspaces
      .map(({ workspace }) => workspace)
      .filter((workspace) => !stillOwnedByAnother.has(workspace.id));
  }

  /**
   * Deletion and deactivation path: refuse to strand a workspace.
   *
   * Taking an account out of service must not silently destroy a tenant's
   * administrability, so this is a hard refusal rather than a cascade. The remedy
   * is in the caller's own hands — transfer ownership, or delete the workspace
   * first — which is why the response names the workspaces instead of asking
   * them to guess.
   *
   * Deletion and deactivation share it because they share the outcome: an
   * inactive account cannot authenticate, so a workspace whose only owner is
   * deactivated is exactly as unadministrable as one whose owner was deleted.
   * Erasure is the one path that does NOT call this — see
   * {@link closeSolelyOwnedWorkspaces}.
   */
  async assertUserIsNotASoleOwner(
    transaction: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    const blockingWorkspaces = await this.findSolelyOwnedLiveWorkspaces(
      transaction,
      userId,
    );
    if (blockingWorkspaces.length > 0) {
      throw Errors.lastOwnerProtected(blockingWorkspaces);
    }
  }

  /**
   * Erasure path: close the workspaces instead of refusing.
   *
   * The asymmetry with `assertUserIsNotASoleOwner` is deliberate. Erasure answers a
   * legal obligation and cannot be declined because of a commercial
   * relationship, so the workspaces are soft-deleted in the same transaction —
   * never left ownerless, never left live.
   *
   * Memberships are left in place, matching `WorkspacesService.remove`: the
   * roster is history, and a restore has to bring it back.
   */
  async closeSolelyOwnedWorkspaces(
    transaction: Prisma.TransactionClient,
    userId: string,
    actorId: string,
  ): Promise<ClosedWorkspacesResult> {
    const workspaces = await this.findSolelyOwnedLiveWorkspaces(
      transaction,
      userId,
    );
    if (workspaces.length === 0) {
      return { workspaces: [], affectedUserIds: [] };
    }

    // Already locked by `findSolelyOwnedLiveWorkspaces`.
    const workspaceIds = workspaces.map((workspace) => workspace.id);

    // Read the roster BEFORE the delete — after it, these users' grants are
    // stale, and this is the only moment the list is still readable.
    const rosters = await transaction.workspaceMembership.findMany({
      where: { workspaceId: { in: workspaceIds } },
      select: { userId: true },
    });

    await transaction.workspace.updateMany({
      where: { id: { in: workspaceIds } },
      data: { deletedAt: new Date(), deletedBy: actorId },
    });

    return {
      workspaces,
      affectedUserIds: [...new Set(rosters.map((member) => member.userId))],
    };
  }
}

/** An ACTIVE membership carrying the owner role — says nothing about the account. */
const ACTIVE_OWNER = {
  status: WorkspaceMembershipStatus.ACTIVE,
  role: { name: SeededRoleName.WORKSPACE_OWNER },
} as const;

/**
 * …and whose account can still sign in.
 *
 * Every ownership COUNT must compose this. Omitting `deletedAt` was the
 * phantom-owner defect: a workspace with one live owner and one soft-deleted
 * owner counted two, so the live one could remove or demote themselves and leave
 * nobody behind.
 *
 * `isActive` is here for the identical reason. `JwtStrategy` refuses an inactive
 * account on every request, so an owner who has been deactivated administers
 * nothing — counting them keeps the arithmetic tidy while the workspace is just
 * as stranded. The predicate is "an owner who can actually act", not "an owner
 * row that still exists".
 */
const ACTIVE_OWNER_OF_USABLE_ACCOUNT = {
  ...ACTIVE_OWNER,
  user: { deletedAt: null, isActive: true },
} as const;
