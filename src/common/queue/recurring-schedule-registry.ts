import type { BaseJobPayloadDto } from './dto/base-job-payload.dto';
import { QueueHeartbeatPayloadDto } from './heartbeat/queue-heartbeat-payload.dto';
import {
  QUEUE_HEARTBEAT_INTERVAL_MILLISECONDS,
  QUEUE_HEARTBEAT_SCHEDULER_ID,
} from './heartbeat/queue-heartbeat.constants';
import { JobName, resolveJobRegistration } from './job-registry';
import type { RecurringSchedule } from './queue-producer.service';

// ── THE recurring-schedule registry ───────────────────────────────────────────
// Every repeating job in the app is DECLARED here, and nowhere else — the third
// registry alongside `queue-registry.ts` and `job-registry.ts`, and the same
// single-source-of-truth shape.
//
// Why a registry rather than one bootstrap class per recurring job: BullMQ job
// schedulers live in REDIS, not in the code. A bespoke class per schedule means
// that deleting the class leaves its scheduler firing forever, producing jobs
// whose name no deployed release recognises. A registry lets
// `RecurringScheduleInstaller` treat this list as authoritative and RECONCILE —
// upserting what is declared and removing what is not — so deleting an entry is
// genuinely enough.
//
// To add a recurring job:
//   1. Register the job in `job-registry.ts` and write its handler.
//   2. Add an entry below. That is the whole change.
export interface RecurringScheduleRegistration {
  readonly schedule: RecurringSchedule;
  readonly jobName: JobName;
  readonly description: string;
  // A factory, not a value: the payload is built fresh at install time so an
  // entry can never accidentally share a mutable object across instances.
  readonly buildPayload: () => BaseJobPayloadDto;
}

function buildHeartbeatPayload(): QueueHeartbeatPayloadDto {
  const payload = new QueueHeartbeatPayloadDto();
  payload.payloadVersion = resolveJobRegistration(
    JobName.MAINTENANCE_QUEUE_HEARTBEAT_V1,
  ).payloadVersion;
  return payload;
}

export const RECURRING_SCHEDULES: readonly RecurringScheduleRegistration[] = [
  {
    schedule: {
      schedulerId: QUEUE_HEARTBEAT_SCHEDULER_ID,
      everyMilliseconds: QUEUE_HEARTBEAT_INTERVAL_MILLISECONDS,
    },
    jobName: JobName.MAINTENANCE_QUEUE_HEARTBEAT_V1,
    description:
      'Proves the producer → Redis → worker loop is alive, and writes the key that backs GET /api/health/workers.',
    buildPayload: buildHeartbeatPayload,
  },
];

export const REGISTERED_SCHEDULER_IDS: ReadonlySet<string> = new Set(
  RECURRING_SCHEDULES.map((registration) => registration.schedule.schedulerId),
);
