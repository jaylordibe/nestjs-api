# Queue and scheduled-work tests

How the queue infrastructure is tested — the real BullMQ round trip, the worker
disabled in `.env.test`, polling with `waitUntil` — is owned by
`src/common/queue/README.md` (Testing), and the scheduler design by its
"Adding a recurring job" section. This file is the checklist for a handler.

## Queue job domain behavior

Prefer calling the job handler directly with a typed payload.

Cover:

- completed;
- target missing/deleted;
- superseded/version mismatch;
- duplicate delivery;
- retryable versus terminal failure;
- idempotent repeated handling;
- partial failure and reconciliation;
- correlation/audit/log context where observable.

The generic queue infrastructure is proved once in `test/queue.e2e-spec.ts`,
not re-proved for every handler.

## Live worker tests

Use a live worker only when the contract depends on the real round trip, and
follow the queue spec's pattern for enabling it. Additionally:

- pause/drain the worker before `truncateAll`, because flushing BullMQ keys while
  a job is active corrupts the job lifecycle;
- close worker/queue/client resources;
- keep jobs inside the current worker's Redis DB;
- use unique/deterministic job identifiers.

## Recurring jobs

There is no wall-clock firing to test and nothing to disarm. Test the three
things that can actually break:

- the handler's own logic — call its public seam (`runOnce()`, or the sweep
  method) directly with controlled time;
- reconciliation — declared schedules are upserted, undeclared ones removed,
  and repeating it changes nothing;
- the runtime gate — an app with `QUEUE_WORKER_ENABLED=false` installs no
  schedulers at all.

Cover, in the handler:

- due versus not due;
- batch limit and deterministic order;
- overlapping invocation;
- atomic claim/lock behavior;
- duplicate-safe enqueue or idempotent side effect;
- per-item failure isolation;
- abandoned-claim recovery;
- metrics/audit/log outcome;
- next run sees only remaining/retryable work.
