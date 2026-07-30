// The queue heartbeat: the one job this infrastructure ships with.
//
// It exists for two reasons, both infrastructural — it carries no domain
// meaning and must never grow any:
//   1. It proves the whole loop end to end (scheduler definition → Redis →
//      worker → side effect) on every deployment, continuously, rather than
//      only when a test runs.
//   2. It IS the worker liveness signal. A worker process has no HTTP server,
//      so it cannot answer a container healthcheck; a recent heartbeat key is
//      the evidence that something is consuming the queues. That matters
//      immediately for `GET /api/health/workers`, and it is what a dedicated
//      worker container's healthcheck will probe when the split happens.
export const QUEUE_HEARTBEAT_SCHEDULER_ID = 'maintenance:queue-heartbeat:v1';

export const QUEUE_HEARTBEAT_INTERVAL_MILLISECONDS = 5 * 60 * 1000;

// Comfortably longer than the interval so a single missed beat does not blank
// the key — the freshness threshold below is what decides "stale", and it can
// then report HOW stale instead of just "absent".
export const QUEUE_HEARTBEAT_KEY_TTL_SECONDS = 60 * 60;

// Two missed intervals plus slack. Tight enough to notice a wedged worker
// within ~15 minutes, loose enough that a slow deploy or a busy queue does not
// flap the health endpoint.
export const QUEUE_HEARTBEAT_STALE_AFTER_MILLISECONDS =
  QUEUE_HEARTBEAT_INTERVAL_MILLISECONDS * 3;

// Namespaced by service to match how BullMQ's own keys are prefixed
// (`queue.module.ts`), so everything this feature writes to Redis sits under
// one recognisable prefix. Environment isolation is NOT what this provides —
// each environment already has a physically separate Redis instance.
export function buildQueueHeartbeatRedisKey(serviceName: string): string {
  return `${serviceName}:queue:heartbeat`;
}
