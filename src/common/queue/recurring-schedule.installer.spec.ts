import type { ConfigService } from '@nestjs/config';
import type { QueueProducerService } from './queue-producer.service';
import { RecurringScheduleInstaller } from './recurring-schedule.installer';
import { RECURRING_SCHEDULES } from './recurring-schedule-registry';
import { REGISTERED_QUEUE_NAMES } from './queue-registry';
import { JOB_REGISTRATIONS, REGISTERED_JOB_NAMES } from './job-registry';

// The gate that separates the two production runtimes. Both directions matter
// and both fail silently on their own:
//
//   - An API instance that installs schedules would RECONCILE, and
//     reconciliation deletes schedulers the running release does not declare —
//     so an API on a different release from the worker pool would delete the
//     pool's schedules and the pool would put them back, indefinitely.
//   - A worker pool that does NOT install them leaves nothing recurring at all,
//     including the heartbeat behind GET /api/health/workers.
//
// Driven as a unit rather than through the e2e app because the bootstrap hook
// is deliberately fire-and-forget: asserting on it there means racing it.
describe('RecurringScheduleInstaller', () => {
  function buildInstaller(isWorkerEnabled: boolean) {
    const upsertedSchedulerIds: string[] = [];
    const removedSchedulerIds: string[] = [];
    // Every queue reports one scheduler the registry does not declare, so the
    // removal half of reconciliation has something to act on.
    const orphanSchedulerId = 'maintenance:decommissioned-job:v1';

    const queueProducer = {
      upsertRecurringSchedule: (
        _jobName: unknown,
        _payload: unknown,
        schedule: { schedulerId: string },
      ) => {
        upsertedSchedulerIds.push(schedule.schedulerId);
        return Promise.resolve();
      },
      listRecurringScheduleIds: () =>
        Promise.resolve([
          ...RECURRING_SCHEDULES.map(
            (registration) => registration.schedule.schedulerId,
          ),
          orphanSchedulerId,
        ]),
      removeRecurringSchedule: (_queueName: unknown, schedulerId: string) => {
        removedSchedulerIds.push(schedulerId);
        return Promise.resolve();
      },
    } as unknown as QueueProducerService;

    const configService = {
      getOrThrow: () => isWorkerEnabled,
    } as unknown as ConfigService;

    return {
      installer: new RecurringScheduleInstaller(queueProducer, configService),
      upsertedSchedulerIds,
      removedSchedulerIds,
      orphanSchedulerId,
    };
  }

  // `onApplicationBootstrap` starts the install without awaiting it, so a
  // synchronous assertion right after would pass for the wrong reason.
  const flushPendingWork = () =>
    new Promise((resolve) => setTimeout(resolve, 0));

  describe('with QUEUE_WORKER_ENABLED=false (the API runtime)', () => {
    it('installs nothing', async () => {
      const { installer, upsertedSchedulerIds } = buildInstaller(false);

      installer.onApplicationBootstrap();
      await flushPendingWork();

      expect(upsertedSchedulerIds).toEqual([]);
    });

    it("removes nothing, so it cannot delete the worker pool's schedulers", async () => {
      const { installer, removedSchedulerIds } = buildInstaller(false);

      installer.onApplicationBootstrap();
      await flushPendingWork();

      expect(removedSchedulerIds).toEqual([]);
    });
  });

  describe('with QUEUE_WORKER_ENABLED=true (the worker runtime)', () => {
    it('upserts every schedule the registry declares', async () => {
      const { installer, upsertedSchedulerIds } = buildInstaller(true);

      installer.onApplicationBootstrap();
      await flushPendingWork();

      expect(upsertedSchedulerIds.sort()).toEqual(
        RECURRING_SCHEDULES.map(
          (registration) => registration.schedule.schedulerId,
        ).sort(),
      );
    });

    it('removes a scheduler the registry no longer declares', async () => {
      const { installer, removedSchedulerIds, orphanSchedulerId } =
        buildInstaller(true);

      installer.onApplicationBootstrap();
      await flushPendingWork();

      // Once per registered queue — the stub reports the orphan on each.
      expect(removedSchedulerIds).toEqual(
        REGISTERED_QUEUE_NAMES.map(() => orphanSchedulerId),
      );
    });

    // Upsert is keyed by scheduler ID, so N worker instances starting at once
    // converge on one definition rather than N. Reconciling twice in one
    // process is the same operation and must be equally inert.
    it('is idempotent — reconciling twice upserts the same set', async () => {
      const { installer, upsertedSchedulerIds } = buildInstaller(true);

      await installer.reconcileNow();
      const afterFirstRun = [...upsertedSchedulerIds];
      upsertedSchedulerIds.length = 0;
      await installer.reconcileNow();

      expect(upsertedSchedulerIds).toEqual(afterFirstRun);
    });
  });

  // A scheduler that produces a job name no release recognises fails every
  // tick, forever, with no code left to explain it. The registry is what makes
  // deleting a recurring job actually stop it, and that only holds while every
  // declared schedule names a registered job.
  it('declares only job names the job registry knows', () => {
    for (const registration of RECURRING_SCHEDULES) {
      // Asserted DIRECTLY. The payload-version check below reaches the registry
      // transitively today, but a `buildPayload` that stopped consulting it
      // would leave this title asserting nothing.
      expect(REGISTERED_JOB_NAMES).toContain(registration.jobName);
    }
  });

  // A payload whose version does not match its registration is failed
  // permanently by the processor, so a scheduler minting one would produce a
  // job that can never run.
  it('builds payloads carrying the registered version', () => {
    for (const registration of RECURRING_SCHEDULES) {
      expect(registration.buildPayload().payloadVersion).toBe(
        JOB_REGISTRATIONS[registration.jobName].payloadVersion,
      );
    }
  });
});
