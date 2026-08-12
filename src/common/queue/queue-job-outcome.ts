import { UnrecoverableError } from 'bullmq';

// What a handler reports back. The distinction is the whole point: BullMQ only
// knows "threw" or "didn't", but most of the interesting outcomes are neither a
// success nor a failure — the booking was cancelled, the consent was withdrawn,
// a newer schedule superseded this job. Those are `SKIPPED`: recorded with a
// reason, not retried, not counted as an error anyone should page on.
export enum JobOutcomeStatus {
  COMPLETED = 'completed',
  SKIPPED = 'skipped',
}

export interface JobOutcome {
  readonly status: JobOutcomeStatus;
  // Required for a skip — a skip with no reason is indistinguishable from a
  // silent bug when someone reads the logs six weeks later.
  readonly reason?: string;
}

// The reason is optional here and mandatory on a skip. A completed job needs no
// explanation, but one that DID something worth counting ("purged 412 rows")
// can say so, and the lifecycle log carries it. Omitted rather than set to
// `undefined` so the stored return value stays exactly `{ status: 'completed' }`
// when there is nothing to add.
export function completedJob(reason?: string): JobOutcome {
  return {
    status: JobOutcomeStatus.COMPLETED,
    ...(reason ? { reason } : {}),
  };
}

export function skippedJob(reason: string): JobOutcome {
  return { status: JobOutcomeStatus.SKIPPED, reason };
}

// Signals a failure that retrying cannot fix — an unreadable payload, an
// unsupported payload version, a job name this release does not know. Extends
// BullMQ's `UnrecoverableError`, which the worker checks to move the job
// straight to `failed` without burning the remaining attempts.
//
// This is the queue-side counterpart of the `Errors.*` factory, not a
// replacement for it: `Errors.*` mints HTTP exceptions for the request path,
// and a worker has no HTTP response to shape.
export class PermanentJobFailureError extends UnrecoverableError {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'PermanentJobFailureError';
  }
}
