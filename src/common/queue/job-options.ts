import type { JobsOptions } from 'bullmq';
import { resolveJobRegistration, type JobName } from './job-registry';
import {
  resolveQueueRetentionPolicy,
  resolveQueueRetryPolicy,
  type JobRetryPolicy,
} from './queue-registry';

// Turns the three registration layers into the BullMQ options a job is enqueued
// with. Resolved in ONE place so no call site can enqueue a job with unlimited
// attempts or unbounded retention — a producer method that built its own
// options would eventually forget one.
//
// Retry precedence, narrowest first:
//   call site  →  job registration  →  queue registration  →  shared default
//
// Retention is NOT overridable per call site: how long finalized jobs are kept
// is an operational property of the queue, not something an individual enqueue
// gets an opinion about.
export function resolveJobOptions(
  jobName: JobName,
  overrides?: {
    readonly retryPolicy?: JobRetryPolicy;
    readonly jobId?: string;
  },
): JobsOptions {
  const registration = resolveJobRegistration(jobName);
  const retryPolicy =
    overrides?.retryPolicy ??
    registration.retryPolicy ??
    resolveQueueRetryPolicy(registration.queueName);
  const retentionPolicy = resolveQueueRetentionPolicy(registration.queueName);

  return {
    attempts: retryPolicy.attempts,
    backoff: {
      type: retryPolicy.backoffStrategy,
      delay: retryPolicy.initialBackoffMilliseconds,
    },
    removeOnComplete: {
      count: retentionPolicy.completedCount,
      age: retentionPolicy.completedAgeSeconds,
    },
    removeOnFail: {
      count: retentionPolicy.failedCount,
      age: retentionPolicy.failedAgeSeconds,
    },
    ...(overrides?.jobId ? { jobId: overrides.jobId } : {}),
  };
}
