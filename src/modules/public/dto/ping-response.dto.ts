// Liveness echo for the guest-mode example route (`GET /public/ping`): an `ok`
// predicate plus the server's current UTC timestamp. Real public endpoints that
// replace the example should follow the same "return a typed DTO" pattern.
export class PingResponseDto {
  ok: boolean;
  timestamp: string;
}
