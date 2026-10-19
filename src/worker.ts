// MUST be first — see the note in src/telemetry.ts. Auto-instrumentation
// patches modules as they are required, so an import above this line is never
// traced, silently.
import { startTelemetry } from './telemetry';

startTelemetry();

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { formatErrorMessage } from './common/util/error-message.util';
import { registerShutdownHandlers } from './graceful-shutdown';

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

  registerShutdownHandlers(applicationContext, logger, 'Worker');

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
