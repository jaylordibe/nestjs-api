import { Injectable, Logger } from '@nestjs/common';
import { formatErrorMessage } from '../util/error-message.util';
import type { BaseJobPayloadDto } from './dto/base-job-payload.dto';
import { resolveJobOptions } from './job-options';
import { resolveJobRegistration, type JobName } from './job-registry';
import { QueueAccessor } from './queue-accessor.service';
import {
  QueueLifecycleEvent,
  QueueLifecycleLogger,
} from './queue-lifecycle.logger';
import type { JobRetryPolicy, QueueName } from './queue-registry';

export interface EnqueueOptions {
  // Supply a deterministic ID (see `buildDeterministicJobId`) to make repeated
  // enqueues of the same logical work collapse into one pending job. Omit it
  // when several jobs of the same type may legitimately be pending for one
  // entity, and BullMQ assigns a unique ID.
  readonly jobId?: string;
  // Narrower than the job's registered policy, for a caller that knows this
  // particular invocation should behave differently.
  readonly retryPolicy?: JobRetryPolicy;
}

export type RecurringSchedule =
  | {
      readonly schedulerId: string;
      readonly cronExpression: string;
      // Mandatory, and mandatory by TYPE rather than by convention: a cron
      // expression without an explicit IANA zone silently follows whatever the
      // container's clock is set to, which is how a job meant to run at 18:00
      // local time ends up firing at 21:00 local on a UTC host.
      readonly timeZone: string;
    }
  | {
      readonly schedulerId: string;
      readonly everyMilliseconds: number;
    };

export interface RescheduleOptions extends EnqueueOptions {
  // The pending job this one supersedes. Removing it is best-effort by design
  // — see `cancelPending`.
  readonly previousJobId: string;
}

export interface RescheduleResult {
  readonly jobId: string;
  readonly previousJobRemoved: boolean;
}

// The states in which a job has not started and can still be pulled back.
// Everything else — `active`, `completed`, `failed` — is either mid-flight or
// already history, and removing it would misreport what happened.
const CANCELLABLE_JOB_STATES = new Set([
  'waiting',
  'delayed',
  'prioritized',
  'waiting-children',
]);

// The API modules use to put work on a queue: immediately, at a future instant,
// or on a recurring schedule — plus cancelling and superseding pending work.
//
// Producers are always available, in every process. Only PROCESSING is gated by
// QUEUE_WORKER_ENABLED, so an API-only instance can still enqueue everything;
// the jobs simply wait in Redis until a worker picks them up.
@Injectable()
export class QueueProducerService {
  private readonly logger = new Logger(QueueProducerService.name);

  constructor(
    private readonly queueAccessor: QueueAccessor,
    private readonly lifecycleLogger: QueueLifecycleLogger,
  ) {}

  // Run as soon as a worker is free.
  async enqueue<TPayload extends BaseJobPayloadDto>(
    jobName: JobName,
    payload: TPayload,
    options?: EnqueueOptions,
  ): Promise<string> {
    const { queueName } = resolveJobRegistration(jobName);
    const queue = this.queueAccessor.getQueue(queueName);
    const job = await queue.add(
      jobName,
      payload,
      resolveJobOptions(jobName, options),
    );

    const jobId = this.requireJobId(job.id, jobName);
    this.lifecycleLogger.record({
      event: QueueLifecycleEvent.ENQUEUED,
      queueName,
      jobName,
      jobId,
      payloadVersion: payload.payloadVersion,
      scheduleVersion: payload.scheduleVersion,
      correlationId: payload.correlationId,
    });
    return jobId;
  }

  // Run no EARLIER than `runAt`. Not "run at `runAt`" — a delay is an
  // eligibility threshold, and the actual start slips with worker availability,
  // queue depth and deploys. Work that needs tighter timing needs a stated
  // tolerance and monitoring, not a different queue.
  async enqueueAt<TPayload extends BaseJobPayloadDto>(
    jobName: JobName,
    payload: TPayload,
    runAt: Date,
    options?: EnqueueOptions,
  ): Promise<string> {
    const { queueName } = resolveJobRegistration(jobName);
    const queue = this.queueAccessor.getQueue(queueName);

    // BullMQ stores a RELATIVE delay, which tells the worker nothing about the
    // schedule it came from. The absolute instant rides in the payload so a
    // handler can still ask "is this when I was supposed to run, and does that
    // still match the domain?".
    const scheduledAt = runAt.toISOString();
    const delayMilliseconds = Math.max(runAt.getTime() - Date.now(), 0);
    const payloadWithSchedule = { ...payload, scheduledAt };

    const job = await queue.add(jobName, payloadWithSchedule, {
      ...resolveJobOptions(jobName, options),
      delay: delayMilliseconds,
    });

    const jobId = this.requireJobId(job.id, jobName);
    this.lifecycleLogger.record({
      event: QueueLifecycleEvent.ENQUEUED,
      queueName,
      jobName,
      jobId,
      payloadVersion: payload.payloadVersion,
      scheduleVersion: payload.scheduleVersion,
      scheduledAt,
      correlationId: payload.correlationId,
    });
    return jobId;
  }

  // Creates or updates a recurring definition. Idempotent by scheduler ID, so
  // running it on every boot — which is exactly what a scheduler provider does
  // — updates the existing definition instead of stacking duplicates.
  async upsertRecurringSchedule<TPayload extends BaseJobPayloadDto>(
    jobName: JobName,
    payload: TPayload,
    schedule: RecurringSchedule,
  ): Promise<void> {
    const { queueName } = resolveJobRegistration(jobName);
    const queue = this.queueAccessor.getQueue(queueName);

    const repeatOptions =
      'cronExpression' in schedule
        ? { pattern: schedule.cronExpression, tz: schedule.timeZone }
        : { every: schedule.everyMilliseconds };

    await queue.upsertJobScheduler(schedule.schedulerId, repeatOptions, {
      name: jobName,
      data: payload,
      opts: resolveJobOptions(jobName),
    });

    this.lifecycleLogger.record({
      event: QueueLifecycleEvent.SCHEDULED,
      queueName,
      jobName,
      jobId: schedule.schedulerId,
      payloadVersion: payload.payloadVersion,
      reason:
        'cronExpression' in schedule
          ? `cron ${schedule.cronExpression} ${schedule.timeZone}`
          : `every ${schedule.everyMilliseconds}ms`,
    });
  }

  // The scheduler IDs currently defined on a queue IN REDIS — which is not the
  // same as the ones this release declares. The gap between the two is what
  // `RecurringScheduleInstaller` reconciles.
  async listRecurringScheduleIds(queueName: QueueName): Promise<string[]> {
    const queue = this.queueAccessor.getQueue(queueName);
    const schedulers = await queue.getJobSchedulers();
    return schedulers.map((scheduler) => scheduler.key);
  }

  // Deletes a recurring definition. Removing the code that created a scheduler
  // does NOT remove the scheduler — it lives in Redis and keeps producing jobs
  // — so this is the only way a repeating job actually stops.
  async removeRecurringSchedule(
    queueName: QueueName,
    schedulerId: string,
  ): Promise<void> {
    const queue = this.queueAccessor.getQueue(queueName);
    await queue.removeJobScheduler(schedulerId);

    this.lifecycleLogger.record({
      event: QueueLifecycleEvent.CANCELLED,
      queueName,
      jobName: 'recurring-schedule',
      jobId: schedulerId,
      reason: 'no longer declared in RECURRING_SCHEDULES',
    });
  }

  // Removes a job that has not started yet. Returns false — rather than
  // throwing — when the job is gone, already running, or already finished.
  //
  // The race is unavoidable and must be tolerated, not prevented: a worker can
  // pick the job up between the caller deciding to cancel and this call landing.
  // That is why cancellation is never the only guard; the handler re-checks
  // domain state and skips a job whose reason to exist has gone.
  async cancelPending(jobName: JobName, jobId: string): Promise<boolean> {
    const { queueName } = resolveJobRegistration(jobName);
    const queue = this.queueAccessor.getQueue(queueName);

    const job = await queue.getJob(jobId);
    if (!job) {
      return false;
    }

    // The state check is load-bearing, not defensive. `getJob` also returns
    // COMPLETED and FAILED jobs — retention keeps them for a day and a week
    // respectively — and BullMQ's `remove()` happily deletes those too, since
    // it only refuses when a lock is held. Without this guard, cancelling a job
    // that already ran would report success, tell the operator through the
    // lifecycle log that it never ran, and destroy the completed-job record
    // that is the evidence it did.
    const state = await job.getState();
    if (!CANCELLABLE_JOB_STATES.has(state)) {
      this.logger.warn(
        `Not cancelling job ${jobId} on queue ${queueName} — it is "${state}", not pending`,
      );
      return false;
    }

    try {
      // `remove()` refuses to delete a locked (active) job, which is precisely
      // the behaviour we want — it protects a job that is mid-side-effect.
      await job.remove();
    } catch (error) {
      this.logger.warn(
        `Could not cancel job ${jobId} on queue ${queueName} — it is most likely already active: ${formatErrorMessage(error)}`,
      );
      return false;
    }

    this.lifecycleLogger.record({
      event: QueueLifecycleEvent.CANCELLED,
      queueName,
      jobName,
      jobId,
    });
    return true;
  }

  // Supersede a pending job with a new one at a new instant.
  //
  // The caller owns steps 1 and 2 of the reschedule contract — update the
  // authoritative domain schedule and bump its version — BEFORE calling this,
  // because the domain row is what a running handler consults to decide whether
  // it is stale. This method does steps 3 through 5.
  //
  // ENQUEUE FIRST, cancel second. The obvious order (remove, then add) has a
  // window where the removal succeeds and the enqueue then fails on a Redis
  // blip — leaving the domain row claiming a job is scheduled and Redis holding
  // nothing, with no error path that puts it back. Reversing it trades that
  // for a window where BOTH jobs are briefly pending, which this design already
  // handles: the older job carries the older `scheduleVersion` and the handler
  // is required to skip it. A duplicate is recoverable; a lost job is not.
  async reschedule<TPayload extends BaseJobPayloadDto>(
    jobName: JobName,
    payload: TPayload,
    runAt: Date,
    options: RescheduleOptions,
  ): Promise<RescheduleResult> {
    if (options.jobId && options.jobId === options.previousJobId) {
      // Enqueue-first makes an unchanged deterministic ID actively dangerous:
      // the "new" job would collapse onto the old one, and the cancel that
      // follows would then delete the replacement. Rescheduling is supposed to
      // bump the schedule version, which mints a different ID.
      throw new Error(
        `Cannot reschedule ${jobName}: the replacement job ID matches the superseded one (${options.jobId}). Bump the schedule version so the replacement gets its own ID.`,
      );
    }

    const jobId = await this.enqueueAt(jobName, payload, runAt, options);
    const previousJobRemoved = await this.cancelPending(
      jobName,
      options.previousJobId,
    );

    const { queueName } = resolveJobRegistration(jobName);
    this.lifecycleLogger.record({
      event: QueueLifecycleEvent.RESCHEDULED,
      queueName,
      jobName,
      jobId,
      payloadVersion: payload.payloadVersion,
      scheduleVersion: payload.scheduleVersion,
      scheduledAt: runAt.toISOString(),
      correlationId: payload.correlationId,
      reason: previousJobRemoved
        ? `superseded ${options.previousJobId}`
        : `could not remove ${options.previousJobId} — it is active, already ran, or is gone; the handler must detect the stale schedule`,
    });

    return { jobId, previousJobRemoved };
  }

  private requireJobId(jobId: string | undefined, jobName: JobName): string {
    if (!jobId) {
      throw new Error(`BullMQ returned no job ID when enqueuing ${jobName}`);
    }
    return jobId;
  }
}
