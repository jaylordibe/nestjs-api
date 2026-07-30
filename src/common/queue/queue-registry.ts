// ── THE queue registry ────────────────────────────────────────────────────────
// Every BullMQ queue in the app is DECLARED here, and nowhere else. `QueueModule`
// reads this to register queues, and the queue processors read it for their
// per-queue worker settings, so the full set of queues and their operational
// knobs is auditable at a glance in one file.
//
// To add a queue:
//   1. Add a `QueueName` member (UPPER_SNAKE key, lowercase_snake value).
//   2. Add its `QUEUE_REGISTRATIONS` entry. The `Record<QueueName, …>` type
//      makes a missing entry a compile error.
//   3. Add a `@ProcessesQueue` subclass of `QueueProcessor` for it (see
//      `processors/maintenance-queue.processor.ts` — it is four lines) and
//      register it in `QueueModule`.
//
// Only declare a queue that actually has a producer. Registering the full menu
// of eventual queues up front would spawn a Worker per empty queue and leave
// dead weight nobody can tell is dead — and `QueueJobHandlerRegistry` fails the
// boot for a queue with no processor precisely so that dead weight cannot
// accumulate quietly.

// Shared retry defaults. Overridable per queue and, more narrowly, per job.
//
// Retry ONLY transient failures — network timeouts, provider outages, rate
// limits, a database or Redis blip. Expected business outcomes (entity gone,
// no longer eligible, already done, schedule superseded) are NOT failures:
// return a `skipped` outcome, or throw `PermanentJobFailureError` if the job
// can never succeed. Retrying those burns five attempts to reach the same
// answer and buries the real signal.
export interface JobRetryPolicy {
  readonly attempts: number;
  readonly backoffStrategy: 'exponential' | 'fixed';
  // Base delay before the first retry. Exponential backoff doubles from here,
  // so 30s yields roughly 30s / 1m / 2m / 4m across five attempts — long enough
  // for a provider to come back, short enough that time-sensitive work is still
  // useful when it lands.
  readonly initialBackoffMilliseconds: number;
}

export const DEFAULT_JOB_RETRY_POLICY: JobRetryPolicy = {
  attempts: 5,
  backoffStrategy: 'exponential',
  initialBackoffMilliseconds: 30_000,
};

// Bounded retention for finalized jobs. Kept as code constants rather than env
// vars: these do not vary per environment and no operator needs to change them
// without a deploy. Completed jobs are the short-term "did it run?" record;
// failed jobs are kept far longer because they are the ones somebody
// investigates.
export interface JobRetentionPolicy {
  readonly completedCount: number;
  readonly completedAgeSeconds: number;
  readonly failedCount: number;
  readonly failedAgeSeconds: number;
}

const ONE_DAY_IN_SECONDS = 86_400;
const ONE_WEEK_IN_SECONDS = 604_800;

export const DEFAULT_JOB_RETENTION_POLICY: JobRetentionPolicy = {
  completedCount: 1_000,
  completedAgeSeconds: ONE_DAY_IN_SECONDS,
  failedCount: 5_000,
  failedAgeSeconds: ONE_WEEK_IN_SECONDS,
};

export enum QueueName {
  // Infrastructure housekeeping — the queue-heartbeat job that proves the
  // producer → Redis → worker loop is alive. The only queue this template
  // ships, because it is the only one with a producer; add a domain queue
  // (`notifications`, `bookings`, …) when you have real work for it.
  MAINTENANCE = 'maintenance',
}

export interface QueueRegistration {
  readonly description: string;
  // Per-queue override for QUEUE_WORKER_CONCURRENCY. Omit to use the env value.
  // Set it for a queue whose jobs are heavy enough that the global default
  // would starve everything else.
  readonly concurrency?: number;
  readonly retryPolicy?: JobRetryPolicy;
  readonly retentionPolicy?: JobRetentionPolicy;
}

export const QUEUE_REGISTRATIONS: Record<QueueName, QueueRegistration> = {
  [QueueName.MAINTENANCE]: {
    description:
      'Infrastructure housekeeping. Low volume, nothing user-visible, so it runs at a deliberately small concurrency and never competes with a domain queue.',
    concurrency: 2,
  },
};

export const REGISTERED_QUEUE_NAMES: readonly QueueName[] =
  Object.values(QueueName);

export function resolveQueueRetryPolicy(queueName: QueueName): JobRetryPolicy {
  return QUEUE_REGISTRATIONS[queueName].retryPolicy ?? DEFAULT_JOB_RETRY_POLICY;
}

export function resolveQueueRetentionPolicy(
  queueName: QueueName,
): JobRetentionPolicy {
  return (
    QUEUE_REGISTRATIONS[queueName].retentionPolicy ??
    DEFAULT_JOB_RETENTION_POLICY
  );
}
