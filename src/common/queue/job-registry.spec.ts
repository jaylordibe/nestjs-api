import {
  JOB_REGISTRATIONS,
  REGISTERED_JOB_NAMES,
  isRegisteredJobName,
} from './job-registry';
import { QUEUE_REGISTRATIONS } from './queue-registry';
import {
  buildDeterministicJobId,
  readPayloadVersionFromJobName,
} from '../util/queue-job-id.util';

// The registry's own conventions, enforced as build failures rather than prose.
// Each of these describes something that compiles and boots today but breaks at
// runtime — which is exactly the class of thing a `Record<Enum, …>` cannot catch
// on its own.
describe('JOB_REGISTRATIONS', () => {
  it.each(REGISTERED_JOB_NAMES)(
    '%s follows the {domain}.{operation}.v{version} naming convention',
    (jobName) => {
      // A name that does not parse compiles fine, then throws the first time
      // anything builds a deterministic ID for it.
      expect(() =>
        buildDeterministicJobId({
          jobName,
          entityId: 'consistency-check',
          scheduleVersion: 1,
        }),
      ).not.toThrow();
    },
  );

  // The payload version lives in two places — the `v{n}` suffix of the job name
  // and `JobRegistration.payloadVersion` — and nothing keeps them in step. A job
  // registered as `…v2` with `payloadVersion: 1` compiles, lints and boots, and
  // then the rolling-deploy guard in QueueProcessor enforces the wrong number,
  // which is worse than having no guard at all.
  it.each(REGISTERED_JOB_NAMES)(
    "%s's registered payload version matches the version in its name",
    (jobName) => {
      expect(JOB_REGISTRATIONS[jobName].payloadVersion).toBe(
        readPayloadVersionFromJobName(jobName),
      );
    },
  );

  it.each(REGISTERED_JOB_NAMES)('%s targets a registered queue', (jobName) => {
    expect(
      QUEUE_REGISTRATIONS[JOB_REGISTRATIONS[jobName].queueName],
    ).toBeDefined();
  });

  it('recognises every registered name and rejects anything else', () => {
    for (const jobName of REGISTERED_JOB_NAMES) {
      expect(isRegisteredJobName(jobName)).toBe(true);
    }
    expect(isRegisteredJobName('booking.expire.v1')).toBe(false);
    // Guards against `hasOwnProperty` being answered by the prototype chain —
    // a processor must not treat `toString` as a runnable job.
    expect(isRegisteredJobName('toString')).toBe(false);
    expect(isRegisteredJobName('constructor')).toBe(false);
  });
});
