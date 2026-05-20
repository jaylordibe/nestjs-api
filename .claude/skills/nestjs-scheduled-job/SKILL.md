---
name: nestjs-scheduled-job
description: Use when adding or editing a scheduled @Cron job (recurring background work — reminder emails, cleanup, retention sweeps). Covers the testable-method-plus-wrapper pattern, the test-env skip, query-baked idempotence with a dedupe column, stamp-after-side-effect failure handling, per-item error isolation, and the e2e test seam.
---

# Scheduled jobs

`ScheduleModule.forRoot()` is registered in `AppModule`. **Cross-cutting jobs** go in `src/common/scheduled-jobs/`; **feature-owned jobs** live alongside the service that owns their data. `src/common/scheduled-jobs/example-heartbeat.service.ts` is a living template — delete it (and its registration in `scheduled-jobs.module.ts`) once real jobs land.

## Per-job pattern

A public method does the work (testable seam); a `@Cron(...)` wrapper just calls it. Don't put logic in the decorated method's body.

```ts
@Cron(CronExpression.EVERY_30_MINUTES)
handleCron(): Promise<void> {
  if (this.configService.get<string>('nodeEnv') === 'test') return Promise.resolve();
  return this.sendDueReminders();
}

async sendDueReminders(): Promise<void> { /* the real work, called directly from tests */ }
```

Full skeleton (with EmailService + dedupe loop) in `docs/resource-pattern.md` (Scheduled job).

## Rules

1. **Public method = testable seam.** Unit/e2e tests drive the public method directly — never test cron timing.
2. **Skip in test.** The scheduler runs in test by default; gate the body on `nodeEnv !== 'test'` so e2e suites don't get noisy side effects.
3. **Idempotence: bake it into the query, not the code.** For "send each row exactly one email," stamp a dedupe column (e.g. `reminderSentAt`) after a successful send and gate the query on it being null. Cron firing twice is fine; the second pass sees nothing to do.
4. **Failure mode: stamp AFTER the side effect.** If the email throws, the row stays unstamped and the next tick retries automatically.
5. **Per-item errors don't kill the loop.** Catch + log per item, continue. One bad row shouldn't block the queue.

## Test seam

Call the public work method directly from e2e; mock the side-effect collaborator (e.g. `EmailService`) and assert the dedupe column flips. `CronExpression` provides named schedules (`EVERY_5_MINUTES`, `EVERY_HOUR`, `EVERY_DAY_AT_MIDNIGHT`, …); pass a raw cron string for bespoke schedules. See the `nestjs-e2e-test` skill for the harness.
