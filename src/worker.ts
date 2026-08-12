// MUST be first — see the note in src/telemetry.ts. Auto-instrumentation
// patches modules as they are required, so an import above this line is never
// traced, silently.
import { startTelemetry, stopTelemetry } from './telemetry';

startTelemetry();

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { formatErrorMessage } from './common/util/error-message.util';
import { QueueWorkerRegistrar } from './common/queue/queue-worker.registrar';

// How long a shutting-down worker waits for its active jobs before giving up
// and logging an incomplete shutdown. Deliberately under the 30s
// `stop_grace_period` on the api service in docs/prod/docker-compose.yml, so
// the process reports what it abandoned instead of being SIGKILLed
// mid-sentence. Lives here rather than in the queue registry: it is a budget
// for this PROCESS, not a property of any queue or job.
const WORKER_SHUTDOWN_TIMEOUT_MILLISECONDS = 25_000;

// ── Standalone queue worker ──────────────────────────────────────────────────
// A second entrypoint into the SAME AppModule, with no HTTP server: it consumes
// BullMQ queues and nothing else. Run it with `yarn start:worker`
// (`node dist/worker`).
//
// This is one half of a two-runtime deployment, and the halves are distinguished
// by exactly one variable:
//
//   API runtime      QUEUE_WORKER_ENABLED=false  →  node dist/main.js
//   Worker runtime   QUEUE_WORKER_ENABLED=true   →  node dist/worker.js
//
// The API never consumes a job and never installs a recurring schedule; this
// process does both. Locally, one process may still do everything —
// `QUEUE_WORKER_ENABLED=true` with `yarn start:dev` — because there is no
// autoscaler to duplicate the work.
//
// Requires QUEUE_WORKER_ENABLED=true — a worker process that does not consume
// is a process doing nothing, so this refuses to start rather than idling
// silently and looking healthy.
//
// There is no in-process scheduler to disarm here. Recurring work is BullMQ job
// schedulers living in Redis (`common/queue/recurring-schedule-registry.ts`),
// installed by `RecurringScheduleInstaller` — which is gated on this same flag,
// so the schedules belong to this runtime by construction rather than by a
// teardown step that had to be remembered.

// Nest's enableShutdownHooks() closes the context on SIGTERM but gives no way
// to bound how long that takes or to say what was still running when the
// container was killed. Handling the signals here buys both: BullMQ stops
// accepting new jobs and drains the active ones, and anything still going when
// the budget runs out is reported rather than vanishing.
function registerShutdownHandlers(
  applicationContext: INestApplicationContext,
  logger: Logger,
): void {
  let isShuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    logger.log(
      `${signal} received — draining active jobs (up to ${WORKER_SHUTDOWN_TIMEOUT_MILLISECONDS}ms)`,
      'Worker',
    );

    const shutdownTimer = setTimeout(() => {
      logger.error(
        `Shutdown did not finish within ${WORKER_SHUTDOWN_TIMEOUT_MILLISECONDS}ms — exiting with jobs still active. They stay in Redis and will be retried once their lock expires.`,
        'Worker',
      );
      process.exit(1);
    }, WORKER_SHUTDOWN_TIMEOUT_MILLISECONDS);
    // Deliberately NOT unref'd. Both branches below clear it, so it can never
    // outlive a completed shutdown — while an unref'd timer would silently fail
    // to fire in exactly the case it exists for: `close()` hanging after every
    // other handle has drained, which would let the process exit 0 and report a
    // clean shutdown for a worker that abandoned active jobs.

    // BullMQ FIRST, then the context. Nest's own ordering runs
    // `onModuleDestroy` — which ends the Postgres pool and quits Redis — before
    // `onApplicationShutdown`, where @nestjs/bullmq closes its workers. Draining
    // after that point would mean finishing jobs against a closed pool, which is
    // not a graceful stop however calmly it is logged.
    applicationContext
      .get(QueueWorkerRegistrar)
      .drainWorkers()
      .then(() => applicationContext.close())
      // Flush telemetry AFTER the context closes, so spans emitted while jobs
      // were draining are included rather than cut off mid-shutdown.
      .then(() => stopTelemetry())
      .then(() => {
        clearTimeout(shutdownTimer);
        logger.log('Worker shut down cleanly', 'Worker');
        process.exit(0);
      })
      .catch((error: unknown) => {
        clearTimeout(shutdownTimer);
        logger.error(
          `Worker shutdown failed: ${formatErrorMessage(error)}`,
          'Worker',
        );
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function bootstrapWorker(): Promise<void> {
  const applicationContext = await NestFactory.createApplicationContext(
    AppModule,
    { bufferLogs: true },
  );
  const logger = applicationContext.get(Logger);
  applicationContext.useLogger(logger);

  const configService = applicationContext.get(ConfigService);
  if (!configService.getOrThrow<boolean>('queue.workerEnabled')) {
    logger.error(
      'QUEUE_WORKER_ENABLED is false — a worker process with consumption disabled would do nothing. Set it to true, or run the API entrypoint instead.',
      'Worker',
    );
    await applicationContext.close();
    process.exit(1);
  }

  registerShutdownHandlers(applicationContext, logger);

  // Reports the DEFAULT, not the effective value — a queue with its own
  // `concurrency` in QUEUE_REGISTRATIONS overrides it, and each processor logs
  // the number it actually runs at. Saying "at concurrency N" here would
  // contradict those lines.
  logger.log(
    `Queue worker ready (default concurrency ${configService.getOrThrow<number>('queue.workerConcurrency')}; each queue logs its own)`,
    'Worker',
  );
}

bootstrapWorker().catch((error: unknown) => {
  // The logger lives inside the application context, which is exactly what
  // failed to come up — so this is the one place `console` is right. Without
  // it, a boot failure (Redis unreachable, or the job-handler registry's
  // completeness check firing) surfaces as a bare unhandled rejection.
  console.error(`Queue worker failed to start: ${formatErrorMessage(error)}`);
  process.exit(1);
});
