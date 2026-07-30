import { resolveJobOptions } from './job-options';
import {
  JOB_REGISTRATIONS,
  JobName,
  REGISTERED_JOB_NAMES,
} from './job-registry';
import {
  DEFAULT_JOB_RETENTION_POLICY,
  DEFAULT_JOB_RETRY_POLICY,
  QUEUE_REGISTRATIONS,
  resolveQueueRetryPolicy,
} from './queue-registry';

describe('resolveJobOptions', () => {
  // The invariant that matters most: nothing this function returns may retry
  // forever or retain forever, whatever the registries happen to say.
  it.each(REGISTERED_JOB_NAMES)(
    'bounds attempts and retention for %s',
    (jobName) => {
      const options = resolveJobOptions(jobName);
      expect(options.attempts).toBeGreaterThanOrEqual(1);
      expect(options.removeOnComplete).toEqual(
        expect.objectContaining({ count: expect.any(Number) as unknown }),
      );
      expect(options.removeOnFail).toEqual(
        expect.objectContaining({ count: expect.any(Number) as unknown }),
      );
    },
  );

  it('applies the job registration retry policy over the queue default', () => {
    const jobName = JobName.MAINTENANCE_QUEUE_HEARTBEAT_V1;
    const jobRetryPolicy = JOB_REGISTRATIONS[jobName].retryPolicy;
    // Guards the assertion below against silently passing if the heartbeat's
    // override is ever removed.
    expect(jobRetryPolicy).toBeDefined();

    expect(resolveJobOptions(jobName).attempts).toBe(jobRetryPolicy?.attempts);
    expect(resolveJobOptions(jobName).attempts).not.toBe(
      resolveQueueRetryPolicy(JOB_REGISTRATIONS[jobName].queueName).attempts,
    );
  });

  it('lets a call site override the registered retry policy', () => {
    const options = resolveJobOptions(JobName.MAINTENANCE_QUEUE_HEARTBEAT_V1, {
      retryPolicy: {
        attempts: 9,
        backoffStrategy: 'fixed',
        initialBackoffMilliseconds: 1_500,
      },
    });
    expect(options.attempts).toBe(9);
    expect(options.backoff).toEqual({ type: 'fixed', delay: 1_500 });
  });

  it('falls back to the shared default when neither job nor queue overrides', () => {
    const jobName = JobName.MAINTENANCE_QUEUE_HEARTBEAT_V1;
    const queueName = JOB_REGISTRATIONS[jobName].queueName;
    // Confirms the fallback is genuinely the path being taken: the queue has no
    // policy of its own, so the shared default is what a job without an
    // override would resolve to.
    expect(QUEUE_REGISTRATIONS[queueName].retryPolicy).toBeUndefined();
    expect(resolveQueueRetryPolicy(queueName)).toEqual(
      DEFAULT_JOB_RETRY_POLICY,
    );

    // And asserted THROUGH resolveJobOptions rather than around it — the
    // heartbeat's own override is temporarily stripped so the fallback runs
    // end to end, which is what this describe block is about.
    const jobRetryPolicy = JOB_REGISTRATIONS[jobName].retryPolicy;
    try {
      delete (JOB_REGISTRATIONS[jobName] as { retryPolicy?: unknown })
        .retryPolicy;
      expect(resolveJobOptions(jobName).attempts).toBe(
        DEFAULT_JOB_RETRY_POLICY.attempts,
      );
      expect(resolveJobOptions(jobName).backoff).toEqual({
        type: DEFAULT_JOB_RETRY_POLICY.backoffStrategy,
        delay: DEFAULT_JOB_RETRY_POLICY.initialBackoffMilliseconds,
      });
    } finally {
      Object.assign(JOB_REGISTRATIONS[jobName], {
        retryPolicy: jobRetryPolicy,
      });
    }
  });

  it('maps the retention policy onto BullMQ removeOnComplete / removeOnFail', () => {
    const options = resolveJobOptions(JobName.MAINTENANCE_QUEUE_HEARTBEAT_V1);
    expect(options.removeOnComplete).toEqual({
      count: DEFAULT_JOB_RETENTION_POLICY.completedCount,
      age: DEFAULT_JOB_RETENTION_POLICY.completedAgeSeconds,
    });
    expect(options.removeOnFail).toEqual({
      count: DEFAULT_JOB_RETENTION_POLICY.failedCount,
      age: DEFAULT_JOB_RETENTION_POLICY.failedAgeSeconds,
    });
    // Failed jobs outlive completed ones — they are the ones somebody
    // investigates after the fact.
    expect(DEFAULT_JOB_RETENTION_POLICY.failedAgeSeconds).toBeGreaterThan(
      DEFAULT_JOB_RETENTION_POLICY.completedAgeSeconds,
    );
  });

  it('omits jobId unless one is supplied, so BullMQ assigns a unique ID', () => {
    expect(
      resolveJobOptions(JobName.MAINTENANCE_QUEUE_HEARTBEAT_V1),
    ).not.toHaveProperty('jobId');
    expect(
      resolveJobOptions(JobName.MAINTENANCE_QUEUE_HEARTBEAT_V1, {
        jobId: 'maintenance.queue-heartbeat.this-service.1',
      }).jobId,
    ).toBe('maintenance.queue-heartbeat.this-service.1');
  });
});
