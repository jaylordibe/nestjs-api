---
name: e2e-testing
description: Applies this repository's real PostgreSQL and Redis e2e harness, parallel worker isolation, shared RBAC fixtures, stable error-contract assertions, queue and scheduled-work test seams, deterministic async testing, and focused/full-suite cadence.
when_to_use: Use when creating or changing test/*.e2e-spec.ts, debugging parallel or Redis-related flakes, testing API contracts, authorization, audit columns, BullMQ handlers, scheduled sweeps, migrations in the isolated test environment, or deciding which tests to run.
user-invocable: false
---

# E2E testing

Read first:

- `CLAUDE.md`
- `test/setup/**`
- `test/test-harness.e2e-spec.ts`
- the closest existing module e2e spec
- `src/common/errors/README.md`
- relevant queue/authorization README contracts

Tests use the real application stack and real isolated PostgreSQL/Redis
resources. Do not replace contract-critical behavior with mocks.

## Core workflow

1. Map each acceptance criterion and risk to an assertion.
2. Boot with `createTestApp()`.
3. Close the app in `afterAll`.
4. Call `truncateAll(app)` in `beforeEach`.
5. Seed RBAC fixtures after truncation when auth is involved.
6. Create all state the spec asserts; never inherit Redis/database state.
7. Assert stable public contracts and direct DB state separately.
8. Keep asynchronous assertions deterministic.
9. Run the affected spec while work is in progress.
10. Run the full suite only under the cadence in `CLAUDE.md`.

## Harness invariants

- `.env.test` is the source of truth.
- `yarn test:e2e` starts the separate test stack through its repository hook.
- Global setup creates/migrates a template database, then clones one DB per Jest
  worker.
- Each worker has its own Redis logical database.
- Redis DB 0 is protected from test flushing.
- `createTestApp()` listens once on an ephemeral port.
- Scheduled timers are unregistered from the test app.
- The live queue worker is disabled by default.
- A spec must never assume exclusive access to external/global state.

Do not point tests at the dev stack, override `.env.test` casually, or reset the
local development database.

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

Do not hand-roll users, roles, permissions, or memberships. Use
`test/setup/rbac.ts` fixtures and seed the catalog after every truncation that
wipes authorization tables.

## Assertions

### Public API

Assert:

- status;
- stable `errorCode`;
- relevant `details`;
- response DTO shape;
- absence of sensitive/audit fields;
- pagination metadata/order;
- authorization and tenant behavior.

Do not assert localized/free-form error messages.

### Database and audit columns

Audit/lifecycle columns intentionally hidden from API responses must be asserted
through `PrismaService`, not the HTTP body.

### Redis and queues

A spec asserting Redis-backed behavior must flush its worker DB first and seed
its own keys.

Prefer direct handler tests for queue job business behavior. Use a live worker
only when the contract genuinely spans enqueue-to-processing infrastructure.

Read:

- `references/resource-and-contract-tests.md`
- `references/queue-and-scheduled-tests.md`

## Determinism

- Poll a condition with a bounded timeout; never use a fixed sleep for async
  completion.
- Control time/randomness where behavior depends on them.
- Await every promise and close every app/client/worker.
- Do not add broad retry loops to hide an unowned background failure.
- Keep test data unique inside the worker when uniqueness matters.
- Do not rely on suite order.

## Evidence cadence

During implementation:

- affected unit specs;
- affected e2e spec(s);
- `yarn build`;
- `yarn lint`.

Run full `yarn test:e2e` only when:

- the module/change is complete;
- the user asks;
- the project release/staging gate requires it.

A filtered run must be labeled filtered. Skipped, flaky, unavailable, or partial
evidence is not a full PASS.

## Quality bar

Reject:

- weak truthiness assertions;
- stale tests left beside new duplicate tests;
- focused/skipped tests;
- arbitrary sleeps;
- over-mocking framework, Prisma, authorization, or serialization contracts;
- shared mutable state;
- snapshots that hide meaningful contract changes;
- tests that modify local development data.
