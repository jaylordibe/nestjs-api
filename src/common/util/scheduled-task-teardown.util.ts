import type { SchedulerRegistry } from '@nestjs/schedule';

// Unregisters every `@nestjs/schedule` task from a process that must not run
// them.
//
// Two callers need this and must never drift apart:
//   - `src/worker.ts` — a standalone queue worker bootstraps the whole
//     AppModule, ScheduleModule included, so without this every @Cron would
//     fire there AS WELL AS in the API container, double-running the work.
//   - `test/setup/test-app.ts` — cron tasks fire on wall-clock boundaries, so
//     a long spec file straddling one would run background jobs against the
//     very database the assertions are reading.
//
// Covers intervals and timeouts, not just crons: the scheduled-jobs module only
// declares `@Cron` today, but the first `@Interval` anyone adds would silently
// escape a cron-only teardown — exactly the kind of drift a shared helper
// exists to prevent.
export function removeAllScheduledTasks(
  schedulerRegistry: SchedulerRegistry,
): number {
  const cronJobNames = [...schedulerRegistry.getCronJobs().keys()];
  for (const cronJobName of cronJobNames) {
    schedulerRegistry.deleteCronJob(cronJobName);
  }

  const intervalNames = [...schedulerRegistry.getIntervals()];
  for (const intervalName of intervalNames) {
    schedulerRegistry.deleteInterval(intervalName);
  }

  const timeoutNames = [...schedulerRegistry.getTimeouts()];
  for (const timeoutName of timeoutNames) {
    schedulerRegistry.deleteTimeout(timeoutName);
  }

  return cronJobNames.length + intervalNames.length + timeoutNames.length;
}
