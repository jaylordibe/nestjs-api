import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QueueAccessor } from './queue-accessor.service';
import { QueueName, REGISTERED_QUEUE_NAMES } from './queue-registry';

export interface QueueDepth {
  readonly name: QueueName;
  readonly waiting: number;
  readonly active: number;
  readonly completed: number;
  readonly failed: number;
  readonly delayed: number;
}

export interface InspectedJob {
  readonly id: string;
  readonly name: string;
  readonly queue: QueueName;
  readonly state: string;
  readonly attemptsMade: number;
  readonly timestamp: number;
  readonly processedOn: number | null;
  readonly finishedOn: number | null;
  readonly failedReason: string | null;
  // The raw enqueued payload. Returned to the CALLER of this service, which is
  // responsible for deciding whether the requester may see it — this layer
  // knows nothing about authorization.
  readonly payload: unknown;
}

/**
 * Operator-facing inspection and recovery for background jobs.
 *
 * Exists as its own service, rather than as methods on `QueueStatusService`,
 * because that one is deliberately narrow: it answers "is the infrastructure
 * healthy", is reachable by the health indicator, and knows nothing about any
 * particular job. Retry and cancel are neither health checks nor enqueues, and
 * folding them in would put a mutating operation within reach of a readiness
 * probe.
 *
 * `QueueAccessor` stays module-private — exporting it from a `@Global()` module
 * would let any domain service grab a raw `Queue` and enqueue around
 * `QueueProducerService`, losing the retry, retention, and lifecycle-logging
 * guarantees resolved there. This service exposes exactly the operator verbs
 * and nothing that can create work.
 */
@Injectable()
export class QueueInspectionService {
  constructor(private readonly queueAccessor: QueueAccessor) {}

  async summarizeDepths(): Promise<QueueDepth[]> {
    return Promise.all(
      REGISTERED_QUEUE_NAMES.map(async (queueName) => {
        const counts = await this.queueAccessor
          .getQueue(queueName)
          .getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
        return {
          name: queueName,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          completed: counts.completed ?? 0,
          failed: counts.failed ?? 0,
          delayed: counts.delayed ?? 0,
        };
      }),
    );
  }

  async findJob(
    queueName: QueueName,
    jobId: string,
  ): Promise<InspectedJob | null> {
    const job = await this.queueAccessor.getQueue(queueName).getJob(jobId);
    if (!job) return null;
    return {
      id: String(job.id),
      name: job.name,
      queue: queueName,
      state: await job.getState(),
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
      processedOn: job.processedOn ?? null,
      finishedOn: job.finishedOn ?? null,
      failedReason: job.failedReason ?? null,
      payload: job.data,
    };
  }

  /**
   * Re-runs a failed job.
   *
   * Returns the state it found, so the caller can report a precise conflict.
   * Only `failed` is retryable: re-running an active job duplicates work
   * already in flight, and re-running a completed one repeats a side effect
   * that already succeeded. Handlers must tolerate duplicate delivery anyway,
   * but "the handler copes" is a weaker guarantee than "an operator cannot
   * trigger it".
   */
  async retryFailedJob(
    queueName: QueueName,
    jobId: string,
  ): Promise<{ retried: boolean; state: string | null }> {
    const job = await this.loadJob(queueName, jobId);
    if (!job) return { retried: false, state: null };

    const state = await job.getState();
    if (state !== 'failed') return { retried: false, state };

    await job.retry();
    return { retried: true, state };
  }

  /**
   * Removes a job that has not started.
   *
   * BullMQ cannot interrupt a running handler, and removing the row mid-flight
   * leaves the worker writing against something that no longer exists — so an
   * `active` job is refused rather than half-cancelled.
   */
  async cancelJob(
    queueName: QueueName,
    jobId: string,
  ): Promise<{ cancelled: boolean; state: string | null }> {
    const job = await this.loadJob(queueName, jobId);
    if (!job) return { cancelled: false, state: null };

    const state = await job.getState();
    if (state === 'active') return { cancelled: false, state };

    await job.remove();
    return { cancelled: true, state };
  }

  private async loadJob(
    queueName: QueueName,
    jobId: string,
  ): Promise<Job | undefined> {
    return this.queueAccessor.getQueue(queueName).getJob(jobId);
  }
}
