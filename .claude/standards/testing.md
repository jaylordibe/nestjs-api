# Testing standard — project edition

## Repository topology

- Yarn is the package manager.
- `.env.test` is the test configuration source of truth.
- e2e startup uses the separate test Compose services.
- global setup owns the destructive test-database lifecycle.
- each Jest worker receives an isolated cloned database and Redis logical DB.
- tests must not assume exclusive access to external/global state.
- local dev data must never be used or reset by tests.

## Layers

Use:

- unit specs for pure rules/utilities;
- e2e/integration specs for Nest validation, filters, serialization, Prisma,
  authorization, transactions, Redis/queues, and public contracts;
- contract assertions for DTO/error/Swagger/event compatibility;
- deterministic concurrency mechanisms for races and duplicates.

## Required scenarios

As relevant:

- success;
- validation details;
- stable error envelope/code;
- unauthenticated/forbidden/cross-tenant;
- 404 versus 403;
- secret exclusion;
- audit actor and request envelope;
- soft deletion and partial uniqueness;
- concurrent updates;
- duplicate/replay/idempotency;
- retry exhaustion and poison jobs;
- provider timeout/failure;
- pagination/order;
- UTC/date/time boundaries;
- money/rounding;
- migration compatibility.

## Quality

Do not over-mock framework/persistence/authorization when those contracts are
under test.

Control time, randomness, network, database, Redis, and workers.

Do not use arbitrary sleeps, weak truthiness, stale duplicate tests, focused
tests, or broad snapshots that hide contract changes.

## Evidence

Every run reports exact command, filter/scope, result, environment, and relevant
output.

`yarn build`, `yarn lint`, affected unit specs, and affected e2e specs are the
normal minimum. Full e2e runs follow `CLAUDE.md` cadence.

Skipped, partial, blocked, or flaky is not PASS.
