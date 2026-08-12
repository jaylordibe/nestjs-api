---
name: e2e-testing
description: This repository's e2e harness — createTestApp/truncateAll, the template-database clone per Jest worker, the per-worker Redis logical database, shared RBAC fixtures, error-envelope assertions, and the focused-versus-full run cadence.
when_to_use: Use when creating or changing test/*.e2e-spec.ts, debugging parallel or Redis-related flakes, testing API contracts, authorization, audit columns, BullMQ handlers, recurring job schedulers, migrations in the isolated test environment, or deciding which tests to run.
user-invocable: false
---

# E2E testing — this repository's harness

The `engineering-framework` standards carry the general testing philosophy —
risk-to-assertion mapping, determinism, and what makes evidence weak. This file
carries **this repository's harness and contract assertions**.

Read first:

- `test/setup/**`
- `test/test-harness.e2e-spec.ts`
- the closest existing module e2e spec
- `src/common/errors/README.md`

Tests use the real application stack against real isolated PostgreSQL and Redis.
Do not replace contract-critical behavior with mocks.

## Harness invariants

- **`.env.test` is the source of truth** — for local runs and for CI, which loads
  the same file and starts the same compose services.
- `yarn test:e2e` starts the separate test stack itself via the `pretest:e2e`
  hook, so it needs no setup.
- `globalSetup` drops and recreates the `.env.test` `DB_NAME`, migrates one
  **template database**, then clones it per Jest worker.
- The suite runs in parallel at `maxWorkers: 50%`. **Each worker gets its own
  Redis logical database** (`test/setup/worker-isolation.ts`).
- Redis DB 0 is protected from test flushing.
- `createTestApp()` listens once on an ephemeral port.
- Scheduled timers are unregistered from the test app; the live queue worker is
  disabled by default.
- **A spec must never assume exclusive access to anything outside its own
  database.**

Never point tests at the dev stack, override `.env.test` casually, or reset the
local development database. Test DB ≠ local DB.

Read `references/harness.md` before changing the harness or debugging a suite
that fails without an assertion.

## Standard spec shape

```ts
beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await truncateAll(app);
});
```

Use Supertest through `app.getHttpServer()`.

Do not hand-roll users, roles, permissions, or memberships — use the
`test/setup/rbac.ts` fixtures, and re-seed the catalog after every truncation
that wipes authorization tables.

## Assertions

**Public API** — assert status, stable `errorCode`, relevant `details`, response
DTO shape, absence of sensitive/audit fields, pagination metadata and order, and
authorization/tenant behavior. **Never assert localized or free-form `message`
text** — messages are free to rotate.

Narrowing supertest bodies keeps ESLint quiet: `const body = res.body as { … }`.

**Database and audit columns** — audit and lifecycle columns deliberately hidden
from API responses are asserted through `PrismaService`, not the HTTP body.

**Redis and queues** — a spec asserting Redis-backed behavior flushes its own
worker DB first and seeds its own keys. Prefer direct handler tests for queue job
business behavior; use a live worker only when the contract genuinely spans
enqueue-to-processing infrastructure.

See `references/resource-and-contract-tests.md` and
`references/queue-and-scheduled-tests.md`.

## Determinism

Poll a condition with a bounded timeout; never sleep a fixed interval for async
completion. Control time and randomness where behavior depends on them. Await
every promise and close every app, client, and worker. Keep test data unique
within the worker when uniqueness matters. Never rely on suite order, and never
add a broad retry loop to hide an unowned background failure.

## Evidence cadence

While implementing: affected unit specs, affected e2e spec(s), `yarn build`,
`yarn lint`.

Run the full `yarn test:e2e` only when the module or change is complete, the user
asks, or a release/staging gate requires it. **A filtered run must be labeled
filtered** — partial evidence is never a full pass.
