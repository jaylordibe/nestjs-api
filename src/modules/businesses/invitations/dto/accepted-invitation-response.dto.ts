// A typed DTO rather than an inline object literal, per the repository's
// acknowledgement-response rule: the shape is part of the contract and has to
// render in `/api/docs`.
//
// Returns the ids the client needs to navigate straight into the business it
// just joined, and nothing else — the full membership is one `GET` away, and
// serving it here would duplicate a response shape that must then be kept in
// step with the memberships endpoint forever.
export class AcceptedInvitationResponseDto {
  businessId!: string;
  membershipId!: string;

  constructor(businessId: string, membershipId: string) {
    this.businessId = businessId;
    this.membershipId = membershipId;
  }
}
