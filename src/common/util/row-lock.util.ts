import type { Prisma } from '@prisma/client';

/**
 * THE lock order for this application. Every `SELECT … FOR UPDATE` lives here.
 *
 *     users  →  businesses  →  refresh_tokens
 *
 * …and within each of those, **ascending by id**.
 *
 * Two invariants need row locks, they overlap on the same rows, and before this
 * file they disagreed about the order. Session revocation locked `users` and
 * then a refresh-token family; account deletion locked the businesses a user
 * owned and *then* that user. A membership path that wanted to lock its target
 * user would have had to take `businesses` first to match one and `users` first
 * to match the other — which is a deadlock, not a choice. Naming one order and
 * putting every primitive behind it is what makes the third caller safe to add.
 *
 * Why `users` comes first: it is the only row that is *always* lockable. A
 * business has an owner; a session has an owner; a user being promoted into a
 * business does not yet appear in that business's roster, so nothing else in the
 * transaction is a stable rendezvous point. Locking the user first means a
 * promotion and a deletion of that same user always contend, even when they
 * disagree about which businesses are involved — which is precisely the race
 * that let a promotion strand an ownerless business.
 *
 * These are plain functions over a `Prisma.TransactionClient`, not a service, so
 * they may live in `src/common/` (the leaf layer) and be shared by the auth and
 * businesses modules without either depending on the other.
 *
 * All of them are no-ops outside a transaction in the sense that matters: a lock
 * taken on an implicit single-statement transaction is released immediately.
 * Always pass the `transaction` argument of a `prisma.$transaction(...)`
 * callback.
 */

/**
 * Serializes every operation on one account — sessions, credentials, lifecycle,
 * and the ownership consequences of all three.
 *
 * It locks `users`, not a dependent table, deliberately: a user with no sessions
 * and no memberships still needs a lockable row, or a revocation racing a first
 * login — or a deletion racing a first promotion — has nothing to serialize
 * against.
 */
export async function lockUserRow(
  transaction: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  await transaction.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
}

/** Several accounts, in ascending id order. See {@link lockBusinessRows}. */
export async function lockUserRows(
  transaction: Prisma.TransactionClient,
  userIds: readonly string[],
): Promise<void> {
  for (const userId of sortedUnique(userIds)) {
    await lockUserRow(transaction, userId);
  }
}

/**
 * Serializes every change that could affect a business's owner count.
 *
 * The lock is on the BUSINESS row, not on a membership row, because the
 * invariant is a property of the business as a whole: two transactions demoting
 * two DIFFERENT owners would never contend on a per-membership lock, and both
 * would observe a count of two.
 */
export async function lockBusinessRow(
  transaction: Prisma.TransactionClient,
  businessId: string,
): Promise<void> {
  await transaction.$queryRaw`SELECT id FROM businesses WHERE id = ${businessId}::uuid FOR UPDATE`;
}

/**
 * Several businesses, always in ascending id order.
 *
 * Two users who co-own the same two businesses can be deleted concurrently;
 * without a total order on the locks, one transaction takes A then B while the
 * other takes B then A, and Postgres resolves it by killing one with a deadlock
 * error the caller never asked for.
 *
 * Locked one statement at a time on purpose. `… WHERE id IN (…) ORDER BY id FOR
 * UPDATE` looks equivalent and is not: the row locks are taken during the scan,
 * which is free to run in physical order, and the sort happens afterwards — so
 * the `ORDER BY` does not order the locking.
 */
export async function lockBusinessRows(
  transaction: Prisma.TransactionClient,
  businessIds: readonly string[],
): Promise<void> {
  for (const businessId of sortedUnique(businessIds)) {
    await lockBusinessRow(transaction, businessId);
  }
}

/**
 * Serializes every operation touching one session family.
 *
 * The lock is taken on the family's EXISTING rows rather than on a single token,
 * because the invariant being protected spans the chain: "a revoked family gains
 * no new children". Two transactions touching different tokens in the same
 * family would never contend on a per-row lock.
 *
 * Last in the order, and it has to be: a family belongs to exactly one user, so
 * anything holding a family lock already had the chance to take that user's.
 */
export async function lockRefreshTokenFamily(
  transaction: Prisma.TransactionClient,
  familyId: string,
): Promise<void> {
  await transaction.$queryRaw`SELECT id FROM refresh_tokens WHERE family_id = ${familyId}::uuid FOR UPDATE`;
}

/**
 * Ascending, duplicates collapsed.
 *
 * De-duplicating matters as much as sorting: locking the same id twice is
 * harmless on its own, but it hides a caller that assembled its list from two
 * sources and would otherwise reveal the overlap here rather than in production.
 */
function sortedUnique(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}
