// Build/runtime provenance for a running container: the deployed commit SHA and
// the process boot time. Curl `/api/health/version` after a deploy — a
// `startedAt` matching the deploy time confirms the container actually restarted
// (rather than serving a stale image).
// The shape of a plain object a handler returns — never constructed, so the
// fields are `declare`d (type and Swagger schema only, nothing emitted).
export class HealthVersionResponseDto {
  declare commit: string;
  declare startedAt: string;
}
