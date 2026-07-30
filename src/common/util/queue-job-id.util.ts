// Deterministic BullMQ job IDs.
//
// A job ID is BullMQ's ONLY built-in de-duplication: enqueuing twice with the
// same ID leaves one job. That makes it a guard against duplicate SCHEDULING —
// it is NOT business idempotence, because it says nothing about whether the
// operation already ran (the job may have completed and been evicted by
// retention long before the duplicate arrives). Anything irreversible still
// needs its own has-this-already-happened check, owned by the domain that
// performs the side effect.
//
// Format (per the queue conventions in src/common/queue/README.md):
//   {domain}.{operation}.{entityId}.{scheduleVersion}
// derived from the job name's own `{domain}.{operation}.v{payloadVersion}`
// shape, so an ID can never drift from the job it belongs to.
//
// Dot-separated, NOT colon-separated: BullMQ reserves `:` for its own Redis key
// namespacing and rejects a custom job ID containing one (Job.validateOptions —
// a four-segment colon form throws "Custom Id cannot contain :"). There is a
// legacy carve-out for exactly three colon-separated segments, but BullMQ's own
// source marks it for removal in the next breaking change, so building on it
// would be building on a countdown. A dot is unambiguous here anyway: domain and
// operation are kebab-case and an entity ID is a UUID, so no segment can contain
// one.
//
// `scheduleVersion` is in the ID on purpose: rescheduling bumps it, which mints
// a DIFFERENT ID, so the replacement never collides with the job it supersedes.
// Removing the superseded job is therefore an explicit step, not a side effect
// — see QueueProducerService.reschedule.

// `{domain}.{operation}.v{n}` — domain and operation are kebab-case words.
const JOB_NAME_PATTERN = /^([a-z][a-z0-9-]*)\.([a-z][a-z0-9-]*)\.v(\d+)$/;

export interface DeterministicJobIdParts {
  jobName: string;
  entityId: string;
  scheduleVersion: number;
}

export function buildDeterministicJobId({
  jobName,
  entityId,
  scheduleVersion,
}: DeterministicJobIdParts): string {
  const match = JOB_NAME_PATTERN.exec(jobName);
  if (!match) {
    throw new Error(
      `Invalid job name "${jobName}" — expected {domain}.{operation}.v{version}`,
    );
  }
  if (entityId.length === 0) {
    throw new Error(`Cannot build a deterministic job ID without an entity ID`);
  }
  if (!Number.isInteger(scheduleVersion) || scheduleVersion < 0) {
    throw new Error(
      `Invalid schedule version "${scheduleVersion}" — expected a non-negative integer`,
    );
  }

  if (entityId.includes(':')) {
    throw new Error(
      `Entity ID "${entityId}" contains ":", which BullMQ rejects in a custom job ID`,
    );
  }

  const [, domain, operation] = match;
  return `${domain}.${operation}.${entityId}.${scheduleVersion}`;
}

// The payload version encoded in the job name itself.
//
// The processor enforces versions against `JobRegistration.payloadVersion`, not
// against this — which means the two could disagree. `job-registry.spec.ts`
// uses this function to assert they never do, so a job registered as `…v2` with
// `payloadVersion: 1` is a build failure rather than a guard silently enforcing
// the wrong number.
export function readPayloadVersionFromJobName(jobName: string): number {
  const match = JOB_NAME_PATTERN.exec(jobName);
  if (!match) {
    throw new Error(
      `Invalid job name "${jobName}" — expected {domain}.{operation}.v{version}`,
    );
  }
  return Number.parseInt(match[3], 10);
}
