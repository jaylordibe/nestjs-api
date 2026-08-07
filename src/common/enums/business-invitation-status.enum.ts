// The lifecycle of a business invitation.
//
// Invitations are modelled separately from memberships because an invited
// email need not belong to a user yet — there is no `userId` to hang a
// membership row on until someone accepts.
//
// `PENDING` is the only state a token can be redeemed from, and the
// transition out of it is a conditional UPDATE rather than a read-then-write,
// so two simultaneous acceptances produce exactly one membership. Expiry is a
// timestamp comparison rather than a status, so an unattended invitation
// needs no sweep to become unusable.
export enum BusinessInvitationStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  // Withdrawn by the business before acceptance.
  REVOKED = 'revoked',
}
