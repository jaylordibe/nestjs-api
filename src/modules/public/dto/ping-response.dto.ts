// Liveness echo for the guest-mode example route (`GET /public/ping`): an `ok`
// predicate plus the server's current UTC timestamp. Real public endpoints that
// replace the example should follow the same "return a typed DTO" pattern.
// The shape of a plain object a handler returns — never constructed, so the
// fields are `declare`d (type and Swagger schema only, nothing emitted).
export class PingResponseDto {
  declare ok: boolean;
  declare timestamp: string;
}
