// Build/runtime provenance for a running container: the deployed commit SHA and
// the process boot time. Curl `/api/health/version` after a deploy — a
// `startedAt` matching the deploy time confirms the container actually restarted
// (rather than serving a stale image).
export class HealthVersionResponseDto {
  commit: string;
  startedAt: string;
}
