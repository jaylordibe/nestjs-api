import { Injectable } from '@nestjs/common';
import { withTimeout } from '../util/promise-timeout.util';
import { QueueAccessor } from './queue-accessor.service';
import { REGISTERED_QUEUE_NAMES } from './queue-registry';

// A queue connection is configured with `maxRetriesPerRequest: null` because
// BullMQ's blocking reads require it — which also means a command issued while
// Redis is unreachable is BUFFERED INDEFINITELY rather than rejected. Without a
// bound, a Redis outage would hang /api/health/readiness open instead of
// failing it, which is the opposite of what a readiness probe is for.
const QUEUE_CONNECTIVITY_TIMEOUT_MILLISECONDS = 2_000;

// Read-only view of the queue infrastructure's state, for health checks.
//
// Separate from the producer because "can I enqueue work" and "is the
// infrastructure healthy" are different questions with different callers, and
// the health indicator should not be able to reach a method that enqueues.
//
// Deliberately knows nothing about any particular job. Worker liveness depends
// on the heartbeat job's key format and freshness rule, so it lives with that
// job in `heartbeat/queue-worker-liveness.service.ts` — keeping `heartbeat/`
// the only place in this module aware that a specific job exists.
@Injectable()
export class QueueStatusService {
  constructor(private readonly queueAccessor: QueueAccessor) {}

  // Pings every registered queue's OWN Redis connection, not the shared
  // RedisService client. BullMQ holds its own connections, so the shared client
  // being healthy proves nothing about whether a job can actually be enqueued.
  //
  // `isPaused()` — a single HEXISTS against the queue's own meta key — rather
  // than `getJobCounts()`. Counts look like the richer probe, but BullMQ's
  // `getCounts` script RPOPs a legacy marker key when it finds one, so a
  // readiness endpoint polled on a loop would be issuing WRITES that hit AOF
  // and replication. A health probe should observe, not mutate. Both are one
  // round trip; only one of them is read-only.
  async verifyQueueConnectivity(): Promise<void> {
    await Promise.all(
      REGISTERED_QUEUE_NAMES.map((queueName) =>
        withTimeout(
          this.queueAccessor.getQueue(queueName).isPaused(),
          QUEUE_CONNECTIVITY_TIMEOUT_MILLISECONDS,
          `Queue "${queueName}" did not respond within ${QUEUE_CONNECTIVITY_TIMEOUT_MILLISECONDS}ms`,
        ),
      ),
    );
  }
}
