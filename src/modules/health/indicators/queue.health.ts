import { Injectable, Logger } from '@nestjs/common';
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { QueueWorkerLivenessService } from '../../../common/queue/heartbeat/queue-worker-liveness.service';
import { QueueStatusService } from '../../../common/queue/queue-status.service';
import { formatErrorMessage } from '../../../common/util/error-message.util';

// `/api/health/*` is @Public(), so the real error goes to the LOGS and the
// response carries a fixed string (CWE-209: information exposure through an
// error message). A raw Redis failure quotes the host, port and sometimes the
// credentials it tried — none of which an unauthenticated caller should be able
// to enumerate. The explicit log calls below are therefore load-bearing, not
// decoration: they are the only place the actual cause survives.
const QUEUE_PUBLIC_FAILURE_MESSAGE = 'Queue infrastructure unreachable';
const WORKER_PUBLIC_FAILURE_MESSAGE = 'No recent queue worker heartbeat';

@Injectable()
export class QueueHealthIndicator {
  private readonly logger = new Logger(QueueHealthIndicator.name);

  constructor(
    private readonly queueStatusService: QueueStatusService,
    private readonly queueWorkerLivenessService: QueueWorkerLivenessService,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  // Can this process reach Redis well enough to enqueue work? This one belongs
  // on readiness: an API that accepts a request it cannot queue follow-up work
  // for is not ready.
  async connectivityCheck(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    try {
      await this.queueStatusService.verifyQueueConnectivity();
      return indicator.up();
    } catch (error) {
      this.logger.error(
        `Queue health check failed: ${formatErrorMessage(error)}`,
      );
      return indicator.down({ message: QUEUE_PUBLIC_FAILURE_MESSAGE });
    }
  }

  // Is anything actually CONSUMING the queues? Deliberately kept off readiness
  // and served from its own endpoint: a worker being down must not take the
  // HTTP API out of the load balancer, because the API can still serve every
  // request and queue the work for whenever a consumer returns.
  //
  // This is also the probe that covers the dedicated worker runtime
  // (`node dist/worker.js`), which has no HTTP server of its own to healthcheck.
  // The heartbeat key in Redis is the only liveness signal it emits, so this
  // endpoint is served by the API and reports on the WORKERS — not on the
  // instance answering the request.
  async workerHeartbeatCheck(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    try {
      const heartbeat = await this.queueWorkerLivenessService.readHeartbeat();
      if (heartbeat.isFresh) {
        return indicator.up({
          observedAt: heartbeat.observedAt?.toISOString(),
        });
      }
      this.logger.warn(
        `Queue worker heartbeat is stale — last seen ${
          heartbeat.observedAt?.toISOString() ?? 'never'
        }, expected within ${heartbeat.staleAfterMilliseconds}ms`,
      );
      // The observed timestamp is safe to publish (it is not topology) and is
      // the one thing that makes this endpoint actionable without log access.
      return indicator.down({
        message: WORKER_PUBLIC_FAILURE_MESSAGE,
        observedAt: heartbeat.observedAt?.toISOString() ?? null,
      });
    } catch (error) {
      this.logger.error(
        `Queue worker heartbeat check failed: ${formatErrorMessage(error)}`,
      );
      return indicator.down({ message: QUEUE_PUBLIC_FAILURE_MESSAGE });
    }
  }
}
