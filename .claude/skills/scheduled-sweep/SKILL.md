---
name: scheduled-sweep
description: Applies the repository's safe pattern for recurring @Cron sweeps that discover due database work, including scheduler-versus-BullMQ selection, bounded batches, multi-instance locking or atomic claims, idempotent enqueue/side effects, failure recovery, observability, and deterministic tests.
when_to_use: Use only for recurring reconciliation, retention, cleanup, or due-row sweeps. Do not use for a per-record delayed job, retryable provider call, notification timer, expiry timer, webhook retry, or work needing cancellation/rescheduling; those belong in BullMQ.
user-invocable: false
---

# Recurring scheduled sweeps

Read first:

- `CLAUDE.md`
- `src/common/queue/README.md`
- existing scheduled-job implementations
- queue registries/processor base
- `e2e-testing` scheduled-work reference

## Decision gate: cron or BullMQ

Use a recurring `@Cron` sweep only when the system periodically discovers work
from authoritative database state, such as:

- retention cleanup;
- reconciliation;
- stale-lease recovery;
- scanning all rows that have become due;
- periodic aggregate/maintenance work.

Use BullMQ for:

- one record at a specific future time;
- delayed notification or expiration;
- retryable external work;
- cancellation/rescheduling;
- per-record lifecycle;
- webhook retry;
- work needing queue backpressure or dead-letter behavior.

A common safe design is:

```text
cron sweep
→ atomically find/claim a bounded due batch
→ enqueue one idempotent BullMQ job per row
→ worker performs the side effect
```

Do not create a second scheduling mechanism beside an existing queue pattern.

## Placement and structure

- Cross-cutting sweeps live in the established scheduled-jobs area.
- Feature-owned sweeps live with the module that owns the data.
- A thin decorated wrapper calls a public testable method.
- Business logic does not live inside the `@Cron` method.

Example shape:

```ts
@Cron(CronExpression.EVERY_30_MINUTES)
handleCron(): Promise<void> {
  return this.runDueSweep();
}

async runDueSweep(): Promise<SweepResult> {
  // bounded, observable, testable work
}
```

The test app unregisters schedulers. Do not add a test-environment branch merely
to compensate for cron firing unless the repository's actual bootstrap requires
one.

## Multi-instance safety

Assume more than one API replica may run the cron simultaneously.

Choose and document one safe mechanism:

- PostgreSQL advisory/distributed lock for the whole sweep;
- atomic row claims with a lease/version;
- atomic update-and-returning batch claim;
- deduplicated/idempotent BullMQ enqueue;
- another proven single-run mechanism already in the repository.

A query such as `WHERE reminder_sent_at IS NULL` followed by an external call
and then a timestamp update is **not exactly-once**. Two replicas can both read
the row and send twice.

Do not claim exactly-once delivery. Define the real guarantee and recovery path.

## Bounded work

Every sweep has:

- explicit batch size;
- deterministic order and tie-breaker;
- bounded loop/page count per tick;
- indexed due/claim predicates;
- timeout or runtime budget;
- metrics/result counts;
- no full-table materialization.

Leave remaining work for the next tick rather than monopolizing the process.

## Claims, side effects, and recovery

### Preferred: claim and enqueue

Within a short transaction:

1. select/claim eligible rows;
2. record claim/version/lease if required;
3. enqueue deterministic idempotency/job identifiers;
4. commit.

The worker owns provider retries and terminal handling.

### Inline side effect: exceptional case

When an inline side effect is genuinely justified:

- acquire an atomic claim/lease first;
- pass an idempotency key to the provider where supported;
- mark completion only after confirmed success;
- release or let the lease expire after failure;
- make abandoned claims recoverable;
- distinguish transient and terminal failure;
- ensure overlap cannot perform the same side effect concurrently.

"Stamp before" can lose work. "Stamp after" can duplicate work. A claim/lease
and idempotency policy resolve the trade-off.

## Failure isolation

One bad row must not hide progress on the rest of the batch.

For each item:

- preserve enough internal error context;
- log safely with correlation and row/job identity;
- classify retryable versus terminal;
- emit audit/metric state where required;
- continue only when continuing is safe;
- avoid an infinite hot retry every cron tick.

Return or log a structured result such as claimed, enqueued/completed, skipped,
retryable failures, and terminal failures.

## Configuration and observability

- Read schedule, batch size, timeout, and feature enablement through typed config.
- Do not read `process.env` directly.
- Preserve request/job correlation where a sweep enqueues work.
- Log start/end counts and duration without sensitive payloads.
- Add metrics/alerts for repeated failure, backlog age, abandoned claims, and
  terminal work where the repository supports them.

## Tests

Do not test wall-clock cron timing.

Call the public sweep method directly with a controlled clock.

Cover:

- due and not-due rows;
- batch bound and deterministic order;
- two overlapping invocations;
- lock/claim exclusion;
- duplicate-safe enqueue or idempotent side effect;
- per-item transient/terminal failure;
- abandoned claim recovery;
- next tick behavior;
- no full-table/unbounded loop;
- logs/audit/metrics where observable.

Use `e2e-testing` for harness details.
