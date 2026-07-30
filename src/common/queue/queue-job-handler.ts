import { SetMetadata } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { BaseJobPayloadDto } from './dto/base-job-payload.dto';
import type { JobName } from './job-registry';
import type { JobOutcome } from './queue-job-outcome';

// A handler is the ONE thing a domain module writes to put work on a queue.
// Everything around it — payload validation, version checking, correlation,
// lifecycle logging, retry classification — belongs to `QueueProcessor` and is
// not the handler's business.
//
// The lifecycle a handler sits inside:
//   receive → validate name + payload → load current domain state →
//   is this job still applicable? → business idempotence check →
//   execute → report completed | skipped
//
// Two rules the base class cannot enforce for you:
//   - RELOAD state. The payload is a set of identifiers, not a snapshot; the
//     row may have changed or vanished since the job was enqueued.
//   - Anything irreversible (an email, a push, a charge) needs its own
//     already-done check. BullMQ is at-least-once and a deterministic job ID
//     does not prove the side effect has not already happened.
export interface QueueJobHandler<
  TPayload extends BaseJobPayloadDto = BaseJobPayloadDto,
> {
  readonly jobName: JobName;
  // The DTO class the raw payload is validated against before `handle` runs.
  readonly payloadType: new () => TPayload;
  handle(payload: TPayload, job: Job): Promise<JobOutcome>;
}

export const QUEUE_JOB_HANDLER_METADATA = 'queue:job-handler';

// Marks a provider as a queue job handler so `QueueJobHandlerRegistry` can find
// it through Nest's DiscoveryService. Discovery rather than a hand-maintained
// array is what lets a domain module contribute a handler without editing
// anything in `src/common/queue/` — the same mechanism @nestjs/bullmq uses to
// find `@Processor` classes.
export const RegisterQueueJobHandler = (): ClassDecorator =>
  SetMetadata(QUEUE_JOB_HANDLER_METADATA, true);
