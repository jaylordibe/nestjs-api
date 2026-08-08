// The lifecycle of one person's relationship with one business.
//
// A membership row is created once per (business, user) pair and then moves
// between these states forever — it is never deleted and never soft-deleted.
// That is what lets `@@unique([businessId, userId])` be an UNCONDITIONAL
// database constraint.
//
// The alternative, soft deletion, cannot express the invariant: SQL treats
// `NULL != NULL`, so `@@unique([businessId, userId, deletedAt])` happily
// accepts two live rows while reporting itself unique. A partial unique index
// on `WHERE deleted_at IS NULL` would hold, but it permits an unbounded pile
// of dead rows per pair, and then "has this person ever been here?" needs a
// scan instead of a single index probe.
//
// ONLY `ACTIVE` grants authority. That is enforced in the grant query
// (`PermissionLoaderService`), not in a guard — a guard runs before the row is
// loaded and so cannot see a status at all.
// There is deliberately no `INVITED` state. A pending invitation is a row in
// `business_invitations`, not a placeholder membership, and the difference is
// not cosmetic: a placeholder reused the ONE row `@@unique([businessId, userId])`
// allows, so inviting a former member silently rewrote their `joinedAt` and
// `endedAt` — destroying real history to record something that had not happened
// yet. Everything the placeholder was there for is already held elsewhere:
// "one outstanding invitation per address" by the partial unique index on
// `business_invitations`, and "who is pending?" by
// `GET /businesses/:id/invitations`.
export enum BusinessMembershipStatus {
  ACTIVE = 'active',
  // Access withdrawn without ending the relationship. Reversible via
  // reactivate; grants nothing meanwhile.
  SUSPENDED = 'suspended',
  // The relationship is over — they left, or were removed. Retained as
  // history and as the anchor for the uniqueness constraint. Grants nothing.
  // Re-joining transitions this same row back to ACTIVE.
  LEFT = 'left',
}
