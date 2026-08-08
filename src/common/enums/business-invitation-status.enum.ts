// The lifecycle of a business invitation.
//
// Invitations are modelled separately from memberships because an invited
// email need not belong to a user yet — there is no `userId` to hang a
// membership row on until someone accepts.
//
// `PENDING` is the only state a token can be redeemed from, and the
// transition out of it is a conditional UPDATE rather than a read-then-write,
// so two simultaneous acceptances produce exactly one membership.
//
// Expiry is primarily a timestamp: a lapsed invitation is unusable the moment
// `expiresAt` passes, with no sweep and no status change. `EXPIRED` exists for a
// second, narrower reason — the partial unique index on `(business_id, email)
// WHERE status = 'pending'` counts a long-dead row as an outstanding
// invitation, which permanently blocked that address from ever being invited to
// that business again. Moving the row out of `pending` is what releases it.
//
// The transition is LAZY — `BusinessInvitationsService.create` performs it under
// the business row lock it already holds, at the only moment the index actually
// collides. There is deliberately no sweep job: a sweep would add operational
// surface and still leave a window between expiry and the next run in which
// `create` fails. A consequence worth knowing: a row that lapsed but never
// collided still reads as `pending` with a past `expiresAt`, so clients must
// treat `expiresAt` — not `status` — as the authority on usability.
//
// **The invariant `accept` depends on: `EXPIRED` is written ONLY by `create`,
// and ONLY to rows whose `expiresAt` has already passed.** `accept` admits both
// `PENDING` and `EXPIRED` past its unknown/consumed/revoked gate and answers
// `INVITATION_EXPIRED` for either — so a writer that stamped `EXPIRED` onto a
// row that had NOT lapsed would make `accept` reject a live invitation. Anything
// that ever writes this status must preserve the "already lapsed" precondition.
//
// Do not collapse `EXPIRED` back into the unknown/consumed gate as a
// simplification. Doing so returns `INVITATION_INVALID` instead of
// `INVITATION_EXPIRED`, which is the least actionable answer, delivered at the
// exact moment a fresh invitation is sitting in the recipient's inbox — and it
// makes the answer depend on whether some unrelated actor happened to re-invite
// the same address.
export enum BusinessInvitationStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  // Withdrawn by the business before acceptance.
  REVOKED = 'revoked',
  // Superseded because it had ALREADY lapsed when a new invitation to the same
  // address was created. Never redeemable: `accept` was already refusing it on
  // `expiresAt` before this status was written, and continues to refuse it —
  // reporting `INVITATION_EXPIRED`, not `INVITATION_INVALID`.
  EXPIRED = 'expired',
}
