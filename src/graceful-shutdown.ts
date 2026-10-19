import type { INestApplicationContext } from '@nestjs/common';
import type { Logger } from 'nestjs-pino';
import { QueueWorkerRegistrar } from './common/queue/queue-worker.registrar';
import { formatErrorMessage } from './common/util/error-message.util';
import { stopTelemetry } from './telemetry';

// How long a shutting-down process waits for its active jobs before giving up
// and logging an incomplete shutdown. Deliberately under the termination grace
// period the platform gives the container (above 25s: "Shutdown" in
// docs/deployment/README.md), so the process reports what it abandoned instead
// of being SIGKILLed mid-sentence. Lives here rather than in the queue
// registry: it is a budget for this PROCESS, not a property of any queue or job.
export const SHUTDOWN_TIMEOUT_MILLISECONDS = 25_000;

/**
 * The one stop sequence, shared by both entrypoints: BullMQ first, then the
 * context, then telemetry.
 *
 * Nest's own ordering runs `onModuleDestroy` — which ends the Postgres pool
 * and quits Redis — before `onApplicationShutdown`, where @nestjs/bullmq closes
 * its workers. Draining after that point would mean finishing jobs against a
 * closed pool, which is not a graceful stop however calmly it is logged. A
 * `beforeApplicationShutdown` hook would not help either: Nest runs it after
 * `onModuleDestroy` too. In the API runtime nothing consumes, so the drain is a
 * no-op; in a process that also consumes (`QUEUE_WORKER_ENABLED=true`, as in
 * a single-container deploy) it is what keeps a deploy from cutting a job off
 * mid-transaction.
 *
 * Flushes telemetry AFTER the context closes, so spans emitted while jobs were
 * draining are included rather than cut off mid-shutdown.
 */
export async function shutDownGracefully(
  applicationContext: INestApplicationContext,
): Promise<void> {
  await applicationContext.get(QueueWorkerRegistrar).drainWorkers();
  await applicationContext.close();
  await stopTelemetry();
}

/**
 * Handles SIGTERM and SIGINT with `shutDownGracefully`, bounded by
 * `SHUTDOWN_TIMEOUT_MILLISECONDS`. Nest's `enableShutdownHooks()` closes the
 * context on a signal but gives no way to drain first, to bound how long that
 * takes, or to say what was still running when the container was killed.
 */
export function registerShutdownHandlers(
  applicationContext: INestApplicationContext,
  logger: Logger,
  context: string,
): void {
  let isShuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    logger.log(
      `${signal} received — draining active jobs (up to ${SHUTDOWN_TIMEOUT_MILLISECONDS}ms)`,
      context,
    );

    const shutdownTimer = setTimeout(() => {
      logger.error(
        `Shutdown did not finish within ${SHUTDOWN_TIMEOUT_MILLISECONDS}ms — exiting anyway. Any job still active stays in Redis and is retried once its lock expires.`,
        context,
      );
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MILLISECONDS);
    // Deliberately NOT unref'd. Both branches below clear it, so it can never
    // outlive a completed shutdown — while an unref'd timer would silently fail
    // to fire in exactly the case it exists for: `close()` hanging after every
    // other handle has drained, which would let the process exit 0 and report a
    // clean shutdown for a process that abandoned active jobs.

    shutDownGracefully(applicationContext)
      .then(() => {
        clearTimeout(shutdownTimer);
        logger.log('Shut down cleanly', context);
        process.exit(0);
      })
      .catch((error: unknown) => {
        clearTimeout(shutdownTimer);
        logger.error(`Shutdown failed: ${formatErrorMessage(error)}`, context);
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
