import { BaseJobPayloadDto } from './dto/base-job-payload.dto';
import {
  QUEUE_HEARTBEAT_INTERVAL_MILLISECONDS,
  QUEUE_HEARTBEAT_SCHEDULER_ID,
} from './heartbeat/queue-heartbeat.constants';
import { JobName, resolveJobRegistration } from './job-registry';
import type { RecurringSchedule } from './queue-producer.service';

// ── THE recurring-schedule registry ───────────────────────────────────────────
// Every repeating job in the app is DECLARED here, and nowhere else — the third
// registry alongside `queue-registry.ts` and `job-registry.ts`, and the same
// single-source-of-truth shape. There is no in-process scheduler; BullMQ job
// schedulers are the ONLY recurring mechanism, and they live in Redis rather
// than in a process.
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
//
// Two properties every entry owes the system, because a scheduler tick is
// at-least-once and nothing here is transactional with the work it triggers:
//   - IDEMPOTENT handler. A duplicate tick, or a retry of a tick, must not
//     repeat an irreversible side effect.
//   - A schedule the work can actually absorb. A sweep that takes longer than
//     its interval will overlap itself; give it a deterministic job ID, or a
//     cadence with headroom.
export interface RecurringScheduleRegistration {
  readonly schedule: RecurringSchedule;
  readonly jobName: JobName;
  readonly description: string;
  // A factory, not a value: the payload is built fresh at install time so an
  // entry can never accidentally share a mutable object across instances.
  readonly buildPayload: () => BaseJobPayloadDto;
}

// A recurring job that acts on no particular row needs nothing in its payload
// beyond the version its handler validates against — and that version must come
// from the job registry rather than a literal, or bumping a payload version
// would leave the scheduler minting jobs the current release rejects.
//
// The concrete DTO class is deliberately NOT referenced here: payloads cross
// into Redis as JSON, so class identity is lost anyway, and requiring it would
// force every domain module's payload type into `src/common/` in violation of
// the layering rule. The processor still validates the JSON against the
// handler's own `payloadType` before it runs.
function buildVersionedPayload(jobName: JobName): BaseJobPayloadDto {
  const payload = new BaseJobPayloadDto();
  payload.payloadVersion = resolveJobRegistration(jobName).payloadVersion;
  return payload;
}

// Every recurring cron in this registry runs on UTC. Stated once, here, rather
// than repeated per entry: deployed containers run on UTC clocks, so a bare
// expression would be UTC by accident. `RecurringSchedule` makes the zone
// mandatory by type precisely so the choice is written down.
const SCHEDULE_TIME_ZONE = 'UTC';

export const RECURRING_SCHEDULES: readonly RecurringScheduleRegistration[] = [
  {
    schedule: {
      schedulerId: QUEUE_HEARTBEAT_SCHEDULER_ID,
      everyMilliseconds: QUEUE_HEARTBEAT_INTERVAL_MILLISECONDS,
    },
    jobName: JobName.MAINTENANCE_QUEUE_HEARTBEAT_V1,
    description:
      'Proves the producer → Redis → worker loop is alive, and writes the key that backs GET /api/health/workers.',
    buildPayload: () =>
      buildVersionedPayload(JobName.MAINTENANCE_QUEUE_HEARTBEAT_V1),
  },
  {
    schedule: {
      schedulerId: 'auth:refresh-token-retention:v1',
      cronExpression: '0 0 * * *',
      timeZone: SCHEDULE_TIME_ZONE,
    },
    jobName: JobName.AUTH_REFRESH_TOKEN_RETENTION_V1,
    description:
      'Nightly deletion of refresh tokens past their expiry. Data minimisation — an expired row still carries a user id, an IP and a user-agent.',
    buildPayload: () =>
      buildVersionedPayload(JobName.AUTH_REFRESH_TOKEN_RETENTION_V1),
  },
];

export const REGISTERED_SCHEDULER_IDS: ReadonlySet<string> = new Set(
  RECURRING_SCHEDULES.map((registration) => registration.schedule.schedulerId),
);
