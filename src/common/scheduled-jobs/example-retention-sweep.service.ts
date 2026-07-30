import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

// Example scheduled job — delete this file (and its registration in
// scheduled-jobs.module.ts) once you've added real jobs. Kept here as a
// living example of the conventions worth following:
//
//   1. **Public method = testable seam.** The @Cron wrapper just calls
//      `runOnce()`. Unit tests can drive `runOnce()` directly without
//      touching the scheduler. Don't put logic inside the @Cron-decorated
//      method's body.
//
//   2. **Skip in test.** The scheduler runs in test by default; gate the
//      body on `nodeEnv !== 'test'` so e2e suites don't get noisy.
//      (`createTestApp` also unregisters every task, so this is the second
//      of two guards — a job driven directly by a unit test still needs it.)
//
//   3. **Per-row try/catch + dedupe column** when iterating. For batch
//      jobs (e.g. "send reminder emails for all bookings due in 24h"),
//      wrap the per-row work in try/catch so one bad row doesn't kill the
//      whole batch, AND write a `<job>SentAt` column on success so the
//      next tick doesn't re-send. The cron's schedule is then "loose by
//      design" — fire often, dedupe per row.
//
//   4. **Idempotency.** Assume the job fires twice for the same instant
//      (clock skew across pods, scheduler restart, manual `runOnce()`
//      call from a runbook). The job must be safe to repeat.
//
// **Is @Cron even the right mechanism?** This is a SWEEP — one query over
// every row matching a condition, on a fixed cadence, safe to miss and safe
// to repeat. That is exactly what @Cron is for. Work that targets ONE entity
// at a computed future instant, or needs retries with backoff, or must be
// cancellable when the entity changes, belongs on the BullMQ queue instead.
// The decision table at the top of src/common/queue/README.md is the whole
// rule; don't pick by habit.
//
// `CronExpression` provides named constants for common schedules:
//   EVERY_MINUTE, EVERY_5_MINUTES, EVERY_30_MINUTES, EVERY_HOUR,
//   EVERY_DAY_AT_MIDNIGHT, EVERY_DAY_AT_NOON, etc. Pass a raw string
//   (`'*/5 * * * *'`) for anything bespoke.
@Injectable()
export class ExampleRetentionSweepService {
  private readonly logger = new Logger(ExampleRetentionSweepService.name);

  constructor(private readonly configService: ConfigService) {}

  @Cron(CronExpression.EVERY_HOUR)
  handleCron(): void {
    if (this.configService.get<string>('nodeEnv') === 'test') {
      return;
    }
    this.runOnce();
  }

  // Public for testability — call it directly from a unit test or a
  // one-off ts-node script to reproduce the cron's effects.
  runOnce(): void {
    this.logger.log('[retention-sweep] tick');
  }
}
