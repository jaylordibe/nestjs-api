import { QueueName } from './queue-registry';
import type { JobRetryPolicy } from './queue-registry';

// ── THE job registry ──────────────────────────────────────────────────────────
// Every queued job type in the app is DECLARED here. The registry binds a job
// name to the queue that carries it and the payload version its workers
// understand, so:
//   - a job can never be enqueued onto a queue nobody processes;
//   - a producer and a worker on different releases disagree LOUDLY (the
//     processor rejects an unknown payload version) instead of silently
//     misreading each other's data during a rolling deploy.
//
// To add a job:
//   1. Add a `JobName` member. The value is `{domain}.{operation}.v{version}`
//      — bump the `v` suffix whenever the payload shape changes incompatibly,
//      and keep the old name registered until every deployed worker has moved.
//   2. Add its `JOB_REGISTRATIONS` entry (`Record<JobName, …>` makes a missing
//      one a compile error).
//   3. Write a payload DTO extending `BaseJobPayloadDto`.
//   4. Write a `QueueJobHandler` for it. `QueueJobHandlerRegistry` fails at
//      BOOT if a registered job has no handler, so a half-wired job can never
//      reach production.
export enum JobName {
  MAINTENANCE_QUEUE_HEARTBEAT_V1 = 'maintenance.queue-heartbeat.v1',
}

export interface JobRegistration {
  readonly queueName: QueueName;
  // The payload version this release's workers accept. A job whose payload
  // carries a different version is failed permanently rather than retried.
  readonly payloadVersion: number;
  readonly description: string;
  // Narrower than the queue's policy, for a job whose failure mode differs from
  // its neighbours' (e.g. a third-party call worth more attempts, or a job that
  // should never be retried at all).
  readonly retryPolicy?: JobRetryPolicy;
}

export const JOB_REGISTRATIONS: Record<JobName, JobRegistration> = {
  [JobName.MAINTENANCE_QUEUE_HEARTBEAT_V1]: {
    queueName: QueueName.MAINTENANCE,
    payloadVersion: 1,
    description:
      'Writes a short-lived Redis key proving the full producer → Redis → worker loop is alive. Backs the worker health probe; carries no domain meaning.',
    // A heartbeat that fails is superseded by the next one a few minutes later,
    // so retrying a stale one is pure noise.
    retryPolicy: {
      attempts: 1,
      backoffStrategy: 'fixed',
      initialBackoffMilliseconds: 0,
    },
  },
};

export const REGISTERED_JOB_NAMES: readonly JobName[] = Object.values(JobName);

export function resolveJobRegistration(jobName: JobName): JobRegistration {
  return JOB_REGISTRATIONS[jobName];
}

// Narrows an arbitrary string (what BullMQ hands a processor as `job.name`) to
// a registered job name. Anything else is a job this release does not know how
// to run — an older producer's name, or a queue namespace collision.
export function isRegisteredJobName(jobName: string): jobName is JobName {
  return Object.prototype.hasOwnProperty.call(JOB_REGISTRATIONS, jobName);
}
