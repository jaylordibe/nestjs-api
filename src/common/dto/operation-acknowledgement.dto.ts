// Canonical acknowledgement body for endpoints that perform a side effect but
// deliberately return no resource — password resets, verification resends, and
// similar "always 200, nothing to leak" actions. A single shared shape so every
// ack documents (and serializes) identically: clients assert `ok === true`.
export class OperationAcknowledgementDto {
  ok: boolean;
}
