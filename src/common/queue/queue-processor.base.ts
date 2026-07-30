import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CLS_ID } from 'nestjs-cls';
import type { Job } from 'bullmq';
import { formatErrorMessage } from '../util/error-message.util';
import type { BaseJobPayloadDto } from './dto/base-job-payload.dto';
import {
  isRegisteredJobName,
  resolveJobRegistration,
  type JobName,
} from './job-registry';
import type { QueueJobHandler } from './queue-job-handler';
import {
  JobOutcomeStatus,
  PermanentJobFailureError,
  type JobOutcome,
} from './queue-job-outcome';
import { QueueLifecycleEvent } from './queue-lifecycle.logger';
import type { QueueProcessorContext } from './queue-processor-context.service';
import { QUEUE_REGISTRATIONS, type QueueName } from './queue-registry';

// Declares a class as the processor for one queue.
//
// Use this instead of `@Processor` directly. `autorun: false` is load-bearing —
// it constructs the Worker without starting consumption, which is what lets
// QUEUE_WORKER_ENABLED=false produce a pure API instance — and a convention
// that must be remembered is a convention that will eventually be forgotten.
// Forgetting it fails SILENTLY in both directions: with the worker disabled the
// Worker consumes until onApplicationBootstrap closes it, and with it enabled
// `run()` rejects with "already running" into the catch below, logging that the
// worker STOPPED consuming a queue it is in fact consuming. Wrapping the option
// in a factory makes that unwritable rather than documented.
export const ProcessesQueue = (queueName: QueueName): ClassDecorator =>
  Processor(queueName, { autorun: false });

// One processor per QUEUE — that is BullMQ's unit, not the job. A `Worker`
// consumes everything on its queue regardless of job name, so this base class
// owns the dispatch to the right `QueueJobHandler`, and every job on the queue
// gets identical validation, correlation, logging and retry classification.
//
// A concrete processor is four lines:
//
//   @ProcessesQueue(QueueName.MAINTENANCE)
//   export class MaintenanceQueueProcessor extends QueueProcessor {
//     constructor(context: QueueProcessorContext) {
//       super(QueueName.MAINTENANCE, context);
//     }
//   }
export abstract class QueueProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger: Logger;

  // Public so the boot-time wiring check can confirm every registered queue
  // actually has a processor — a queue with none accepts jobs that nothing ever
  // consumes, and every other signal (enqueue succeeds, connectivity healthy)
  // stays green.
  readonly consumedQueueName: QueueName;

  protected constructor(
    private readonly queueName: QueueName,
    private readonly context: QueueProcessorContext,
  ) {
    super();
    this.consumedQueueName = queueName;
    this.logger = new Logger(`QueueProcessor:${queueName}`);
  }

  onApplicationBootstrap(): void {
    // onApplicationBootstrap, not onModuleInit: @nestjs/bullmq's explorer
    // assigns `this.worker` during its own onModuleInit, and module init order
    // between two modules is not something to bet on.
    const isWorkerEnabled = this.context.configService.getOrThrow<boolean>(
      'queue.workerEnabled',
    );

    if (!isWorkerEnabled) {
      // Close rather than merely leave it un-run, so an API-only instance holds
      // no idle Redis connection for a queue it will never consume. `close()`
      // is idempotent, so the framework closing it again at shutdown is fine.
      //
      // Handled, not floated: close() rejects if Redis is still coming up
      // during a deploy, and an unhandled rejection would kill the HTTP API at
      // boot over a queue this process does not even consume.
      this.worker.close().catch((error: unknown) => {
        this.logger.warn(
          `Could not close the unused worker for queue "${this.queueName}": ${formatErrorMessage(error)}`,
        );
      });
      this.logger.log(
        `Worker disabled by configuration — this process produces to "${this.queueName}" but does not consume it`,
      );
      return;
    }

    this.worker.concurrency =
      QUEUE_REGISTRATIONS[this.queueName].concurrency ??
      this.context.configService.getOrThrow<number>('queue.workerConcurrency');

    // Listeners attached programmatically rather than with @OnWorkerEvent
    // because that decorator is only scanned on the concrete class's own
    // prototype — declaring it here, on the base, would silently do nothing.
    this.worker.on('error', (error) => {
      this.logger.error(
        `BullMQ worker error on queue "${this.queueName}": ${formatErrorMessage(error)}`,
      );
    });
    this.worker.on('stalled', (jobId) => {
      this.logger.warn(
        `Job ${jobId} stalled on queue "${this.queueName}" — it will be retried or failed by BullMQ`,
      );
    });

    // `run()` resolves only when the worker closes, so it is deliberately not
    // awaited — but it must still be handled. It rejects if the process shuts
    // down while the consume loop is still starting, and an unhandled rejection
    // there would take the process down during what is otherwise an orderly
    // shutdown.
    this.worker.run().catch((error: unknown) => {
      if (this.worker.closing) {
        return;
      }
      this.logger.error(
        `Worker stopped consuming queue "${this.queueName}": ${formatErrorMessage(error)}`,
      );
    });
    this.logger.log(
      `Worker consuming queue "${this.queueName}" at concurrency ${this.worker.concurrency}`,
    );
  }

  // `final` in spirit — subclasses supply handlers, never their own process().
  async process(job: Job): Promise<JobOutcome> {
    const startedAtMilliseconds = Date.now();
    // attemptsMade counts PREVIOUS attempts (BullMQ increments it when the job
    // finishes, not when it starts), so the current attempt is one more.
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    const jobId = job.id ?? 'unknown';

    try {
      const { handler, payload } = await this.resolveJob(job);

      this.context.lifecycleLogger.record({
        event: QueueLifecycleEvent.STARTED,
        queueName: this.queueName,
        jobName: job.name,
        jobId,
        payloadVersion: payload.payloadVersion,
        scheduleVersion: payload.scheduleVersion,
        scheduledAt: payload.scheduledAt,
        attempt,
        maxAttempts,
        correlationId: payload.correlationId,
      });

      // A worker has no HTTP request, so nothing has opened a CLS scope for it.
      // Opening one here means a handler calling AuditService still produces a
      // correlated envelope carrying the ID of the HTTP call that enqueued the
      // job. Only the request ID is seeded — faking `ip` / `userAgent` / `path`
      // for a background job would put invented forensic data into audit_logs.
      //
      // Seeded under the CLS_ID SYMBOL, not a `'requestId'` string key.
      // `AuditService` reads it via `cls.getId()`, which resolves that symbol
      // and nothing else — a string key of the same name is written to a
      // different slot, reads back as undefined, and the correlation silently
      // does not happen.
      const outcome = await this.context.clsService.run(async () => {
        this.context.clsService.set(
          CLS_ID,
          payload.correlationId ?? `job.${jobId}`,
        );
        return handler.handle(payload, job);
      });

      this.context.lifecycleLogger.record({
        event:
          outcome.status === JobOutcomeStatus.SKIPPED
            ? QueueLifecycleEvent.SKIPPED
            : QueueLifecycleEvent.COMPLETED,
        queueName: this.queueName,
        jobName: job.name,
        jobId,
        payloadVersion: payload.payloadVersion,
        scheduleVersion: payload.scheduleVersion,
        scheduledAt: payload.scheduledAt,
        attempt,
        maxAttempts,
        durationMilliseconds: Date.now() - startedAtMilliseconds,
        correlationId: payload.correlationId,
        reason: outcome.reason,
      });

      return outcome;
    } catch (error) {
      // Mirrors BullMQ's own retry decision (Job.shouldRetryJob) so the log
      // says what is actually about to happen rather than guessing.
      const willRetry =
        !(error instanceof PermanentJobFailureError) && attempt < maxAttempts;

      this.context.lifecycleLogger.record({
        event: willRetry
          ? QueueLifecycleEvent.RETRIED
          : QueueLifecycleEvent.FAILED,
        queueName: this.queueName,
        jobName: job.name,
        jobId,
        attempt,
        maxAttempts,
        durationMilliseconds: Date.now() - startedAtMilliseconds,
        reason: formatErrorMessage(error),
      });

      throw error;
    }
  }

  // Everything that must hold before a handler is allowed to run. Each failure
  // here is permanent by construction: no number of retries turns an unknown
  // job name or an unreadable payload into a runnable job.
  private async resolveJob(job: Job): Promise<{
    handler: QueueJobHandler;
    payload: BaseJobPayloadDto;
  }> {
    if (!isRegisteredJobName(job.name)) {
      throw new PermanentJobFailureError(
        `Unknown job name "${job.name}" — this release has no registration for it`,
      );
    }
    const jobName: JobName = job.name;
    const registration = resolveJobRegistration(jobName);

    // Widened to string deliberately. While QueueName has a single member,
    // comparing the enum values narrows the mismatch branch to `never` and the
    // message below stops type-checking — even though the check becomes
    // genuinely load-bearing the moment a second queue is registered. Widening
    // keeps the guard (and its message) alive through that transition.
    const registeredQueueName: string = registration.queueName;
    const processorQueueName: string = this.queueName;
    if (registeredQueueName !== processorQueueName) {
      throw new PermanentJobFailureError(
        `Job "${jobName}" belongs to queue "${registeredQueueName}" but arrived on "${processorQueueName}"`,
      );
    }

    const handler = this.context.handlerRegistry.findByJobName(jobName);
    if (!handler) {
      throw new PermanentJobFailureError(
        `No handler registered for job "${jobName}"`,
      );
    }

    const payload = plainToInstance(handler.payloadType, job.data);
    const validationErrors = await validate(payload, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (validationErrors.length > 0) {
      // Property names only. The offending VALUES are deliberately not quoted:
      // a payload can carry identifiers, and a failed job is retained for a
      // week where anyone with log access can read it.
      throw new PermanentJobFailureError(
        `Invalid payload for job "${jobName}" — offending properties: ${validationErrors
          .map((validationError) => validationError.property)
          .join(', ')}`,
      );
    }

    // The rolling-deploy guard. An old worker meeting a new producer's payload
    // fails loudly and visibly here instead of half-reading the data.
    if (payload.payloadVersion !== registration.payloadVersion) {
      throw new PermanentJobFailureError(
        `Unsupported payload version ${payload.payloadVersion} for job "${jobName}" — this release supports version ${registration.payloadVersion}`,
      );
    }

    return { handler, payload };
  }
}
