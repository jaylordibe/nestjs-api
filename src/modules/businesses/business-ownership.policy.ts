import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BusinessMembershipStatus } from '../../common/enums/business-membership-status.enum';
import { SeededRoleName } from '../../common/enums/seeded-role-name.enum';
import { Errors } from '../../common/errors/errors';
import {
  lockBusinessRow,
  lockBusinessRows,
  lockUserRow,
} from '../../common/util/row-lock.util';

/** A live business whose only remaining active owner is the user in question. */
export interface SolelyOwnedBusiness {
  id: string;
  name: string;
}

export interface ClosedBusinessesResult {
  businesses: SolelyOwnedBusiness[];
  /** Every roster member of the closed businesses — their grants are now stale. */
  affectedUserIds: string[];
}

/**
 * The one place that answers "does this business still have an owner?".
 *
 * The invariant — every live business has at least one ACTIVE owner whose
 * account is live — is not a membership concern. It is violated just as easily
 * from the USER side: deleting an account silently strands an ACTIVE
 * BUSINESS_OWNER membership pointing at a dead user. That row is invisible to
 * every roster read (they all filter on a live user), so no business-level actor
 * can repair it — `BUSINESS_ADMIN` holds no `transferOwnership`. Only a platform
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
 * **Lock order: the user row, then the business row.** Both are taken from
 * `src/common/util/row-lock.util.ts`, which is where the order is documented and
 * why. Any mutation that can leave somebody holding — or no longer holding — an
 * ACTIVE owner membership must take BOTH, in that order: the business lock alone
 * cannot serialise against an account deletion, because a deletion only knows to
 * lock the businesses the account ALREADY owns.
 */
@Injectable()
export class BusinessOwnershipPolicy {
  /**
   * Serialize every change that could affect a business's owner count.
   *
   * The lock is on the BUSINESS row, not the membership row, because the
   * invariant is a property of the business as a whole: two transactions
   * demoting two DIFFERENT owners would never contend on a per-membership lock,
   * and both would observe a count of two.
   */
  async lockBusiness(
    transaction: Prisma.TransactionClient,
    businessId: string,
  ): Promise<void> {
    await lockBusinessRow(transaction, businessId);
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
   * Refuse the operation unless the business keeps an owner without this
   * membership.
   *
   * `excludingMembershipId` is the membership about to be removed, demoted, or
   * suspended — the count must not include it.
   */
  async assertAnotherActiveOwnerExists(
    transaction: Prisma.TransactionClient,
    businessId: string,
    excludingMembershipId: string,
  ): Promise<void> {
    const remainingOwners = await transaction.businessMembership.count({
      where: {
        businessId,
        id: { not: excludingMembershipId },
        ...ACTIVE_OWNER_OF_USABLE_ACCOUNT,
      },
    });
    if (remainingOwners === 0) {
      throw Errors.lastOwnerProtected();
    }
  }

  /**
   * The live businesses this user owns alone, resolved under a lock.
   *
   * The lock is taken between the two reads and is not optional: without it,
   * two co-owners deleting their accounts simultaneously each see the other and
   * both proceed, which is the exact outcome the invariant exists to prevent.
   * Folding it in here means no caller can forget it.
   *
   * Two queries rather than one per business — the roster grouping is what makes
   * "alone" a set operation instead of an N+1 walk.
   */
  async findSolelyOwnedLiveBusinesses(
    transaction: Prisma.TransactionClient,
    userId: string,
  ): Promise<SolelyOwnedBusiness[]> {
    const ownedBusinesses = await transaction.businessMembership.findMany({
      where: {
        userId,
        business: { deletedAt: null },
        ...ACTIVE_OWNER,
      },
      select: { business: { select: { id: true, name: true } } },
      orderBy: { businessId: 'asc' },
    });
    if (ownedBusinesses.length === 0) {
      return [];
    }

    const ownedBusinessIds = ownedBusinesses.map(({ business }) => business.id);
    await lockBusinessRows(transaction, ownedBusinessIds);

    const businessesWithCoOwner = await transaction.businessMembership.groupBy({
      by: ['businessId'],
      where: {
        businessId: { in: ownedBusinessIds },
        // Somebody OTHER than the user being removed, and holding an account
        // that can still sign in. An owner whose account is gone — or switched
        // off — is not an owner.
        userId: { not: userId },
        ...ACTIVE_OWNER_OF_USABLE_ACCOUNT,
      },
    });
    const stillOwnedByAnother = new Set(
      businessesWithCoOwner.map((group) => group.businessId),
    );

    return ownedBusinesses
      .map(({ business }) => business)
      .filter((business) => !stillOwnedByAnother.has(business.id));
  }

  /**
   * Deletion and deactivation path: refuse to strand a business.
   *
   * Taking an account out of service must not silently destroy a tenant's
   * administrability, so this is a hard refusal rather than a cascade. The remedy
   * is in the caller's own hands — transfer ownership, or delete the business
   * first — which is why the response names the businesses instead of asking
   * them to guess.
   *
   * Deletion and deactivation share it because they share the outcome: an
   * inactive account cannot authenticate, so a business whose only owner is
   * deactivated is exactly as unadministrable as one whose owner was deleted.
   * Erasure is the one path that does NOT call this — see
   * {@link closeSolelyOwnedBusinesses}.
   */
  async assertUserIsNotASoleOwner(
    transaction: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    const blockingBusinesses = await this.findSolelyOwnedLiveBusinesses(
      transaction,
      userId,
    );
    if (blockingBusinesses.length > 0) {
      throw Errors.lastOwnerProtected(blockingBusinesses);
    }
  }

  /**
   * Erasure path: close the businesses instead of refusing.
   *
   * The asymmetry with `assertUserIsNotASoleOwner` is deliberate. Erasure answers a
   * legal obligation and cannot be declined because of a commercial
   * relationship, so the businesses are soft-deleted in the same transaction —
   * never left ownerless, never left live.
   *
   * Memberships are left in place, matching `BusinessesService.remove`: the
   * roster is history, and a restore has to bring it back.
   */
  async closeSolelyOwnedBusinesses(
    transaction: Prisma.TransactionClient,
    userId: string,
    actorId: string,
  ): Promise<ClosedBusinessesResult> {
    const businesses = await this.findSolelyOwnedLiveBusinesses(
      transaction,
      userId,
    );
    if (businesses.length === 0) {
      return { businesses: [], affectedUserIds: [] };
    }

    // Already locked by `findSolelyOwnedLiveBusinesses`.
    const businessIds = businesses.map((business) => business.id);

    // Read the roster BEFORE the delete — after it, these users' grants are
    // stale, and this is the only moment the list is still readable.
    const rosters = await transaction.businessMembership.findMany({
      where: { businessId: { in: businessIds } },
      select: { userId: true },
    });

    await transaction.business.updateMany({
      where: { id: { in: businessIds } },
      data: { deletedAt: new Date(), deletedBy: actorId },
    });

    return {
      businesses,
      affectedUserIds: [...new Set(rosters.map((member) => member.userId))],
    };
  }
}

/** An ACTIVE membership carrying the owner role — says nothing about the account. */
const ACTIVE_OWNER = {
  status: BusinessMembershipStatus.ACTIVE,
  role: { name: SeededRoleName.BUSINESS_OWNER },
} as const;

/**
 * …and whose account can still sign in.
 *
 * Every ownership COUNT must compose this. Omitting `deletedAt` was the
 * phantom-owner defect: a business with one live owner and one soft-deleted
 * owner counted two, so the live one could remove or demote themselves and leave
 * nobody behind.
 *
 * `isActive` is here for the identical reason. `JwtStrategy` refuses an inactive
 * account on every request, so an owner who has been deactivated administers
 * nothing — counting them keeps the arithmetic tidy while the business is just
 * as stranded. The predicate is "an owner who can actually act", not "an owner
 * row that still exists".
 */
const ACTIVE_OWNER_OF_USABLE_ACCOUNT = {
  ...ACTIVE_OWNER,
  user: { deletedAt: null, isActive: true },
} as const;
