import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BusinessMembershipStatus } from '../../common/enums/business-membership-status.enum';
import { SeededRoleName } from '../../common/enums/seeded-role-name.enum';
import { Errors } from '../../common/errors/errors';

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
    await transaction.$queryRaw`SELECT id FROM businesses WHERE id = ${businessId}::uuid FOR UPDATE`;
  }

  /**
   * Lock several businesses, always in ascending id order.
   *
   * Two users who co-own the same two businesses can be deleted concurrently;
   * without a total order on the locks, one transaction takes A then B while the
   * other takes B then A, and Postgres resolves it by killing one with a
   * deadlock error the caller never asked for.
   *
   * Locked one statement at a time on purpose. `... WHERE id IN (…) ORDER BY id
   * FOR UPDATE` looks equivalent and is not: the row locks are taken during the
   * scan, which is free to run in physical order, and the sort happens
   * afterwards — so the ORDER BY does not order the locking.
   */
  async lockBusinesses(
    transaction: Prisma.TransactionClient,
    businessIds: readonly string[],
  ): Promise<void> {
    for (const businessId of [...businessIds].sort()) {
      await this.lockBusiness(transaction, businessId);
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
        ...ACTIVE_OWNER_OF_LIVE_ACCOUNT,
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
    await this.lockBusinesses(transaction, ownedBusinessIds);

    const businessesWithCoOwner = await transaction.businessMembership.groupBy({
      by: ['businessId'],
      where: {
        businessId: { in: ownedBusinessIds },
        // Somebody OTHER than the user being removed, and holding a live
        // account. An owner whose account is gone is not an owner.
        userId: { not: userId },
        ...ACTIVE_OWNER_OF_LIVE_ACCOUNT,
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
   * Deletion path: refuse to strand a business.
   *
   * Closing an account must not silently destroy a tenant's administrability, so
   * this is a hard refusal rather than a cascade. The remedy is in the caller's
   * own hands — transfer ownership, or delete the business first — which is why
   * the response names the businesses instead of asking them to guess.
   */
  async assertUserMayBeDeleted(
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
   * The asymmetry with `assertUserMayBeDeleted` is deliberate. Erasure answers a
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
 * …and whose account still exists.
 *
 * Every ownership COUNT must compose this. Omitting it was the phantom-owner
 * defect: a business with one live owner and one soft-deleted owner counted two,
 * so the live one could remove or demote themselves and leave nobody behind.
 */
const ACTIVE_OWNER_OF_LIVE_ACCOUNT = {
  ...ACTIVE_OWNER,
  user: { deletedAt: null },
} as const;
