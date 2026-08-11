---
name: scheduled-sweep
description: This repository's placement, structure, and test seam for recurring @Cron sweeps — where a sweep lives, the thin-wrapper shape, how the test app disarms schedulers, and when the work belongs on BullMQ instead.
when_to_use: Use only for recurring reconciliation, retention, cleanup, or due-row sweeps. Do not use for a per-record delayed job, retryable provider call, notification timer, expiry timer, webhook retry, or work needing cancellation/rescheduling; those belong in BullMQ.
user-invocable: false
---

# Recurring scheduled sweeps — this repository's answers

The `engineering-framework:domain-background-work` skill carries the questions:
sweep-versus-job selection, multi-instance safety, atomic claiming, bounded
batches, idempotency, poison handling, and failure isolation. **Read it for the
reasoning.** This file carries only what is specific to this repository.

Read first:

- `src/common/queue/README.md` — the decision table at the top is authoritative
- existing scheduled-job implementations
- the queue registries and `QueueProcessor` base

## Which mechanism

**BullMQ is the default for new background work.** A recurring `@Cron` sweep is
correct only when the system periodically discovers work from authoritative
database state — retention cleanup, reconciliation, stale-lease recovery,
scanning rows that have become due, periodic maintenance.

Anything per-record — a delayed notification, an expiry timer, a retryable
provider call, a webhook retry, or work needing cancellation or rescheduling —
goes on the queue. The decision table in `src/common/queue/README.md` is the
tiebreaker; do not create a second scheduling mechanism beside it.

The composed shape this repository prefers:

```text
cron sweep
→ atomically claim a bounded due batch
→ enqueue one idempotent BullMQ job per row
→ worker performs the side effect
```

## Placement and structure

- Cross-cutting sweeps live in `src/common/scheduled-jobs/`.
- Feature-owned sweeps live with the module that owns the data.
- The `@Cron` method is a **thin wrapper** over a public, testable method.
  Business logic never lives inside the decorated method.

```ts
@Cron(CronExpression.EVERY_30_MINUTES)
handleCron(): Promise<void> {
  return this.runDueSweep();
}

async runDueSweep(): Promise<SweepResult> {
  // bounded, observable, testable work
}
```

## Repository specifics

- **The test app unregisters schedulers.** Do not add a test-environment branch
  to compensate for cron firing unless the actual bootstrap requires one.
- Read schedule, batch size, timeout, and feature enablement through
  `configService.getOrThrow<T>('dot.path')` into `configuration.ts`. Never
  `process.env`.
- A sweep that enqueues work must pass `correlationId` through, so the job's log
  lines carry the originating request ID — `QueueProcessor` opens the CLS scope
  and seeds the request ID from the payload.
- Log start/end counts and duration without sensitive payloads.
- Audit privileged outcomes through `AuditService` (best-effort; never blocks).

## Tests

Do not test wall-clock cron timing. Call the public sweep method directly with a
controlled clock.

Cover: due and not-due rows; batch bound and deterministic order; two overlapping
invocations; lock/claim exclusion; duplicate-safe enqueue or idempotent side
effect; per-item transient versus terminal failure; abandoned claim recovery;
next-tick behavior; no full-table or unbounded loop; logs/audit/metrics where
observable.

Use the `e2e-testing` skill for harness details.
