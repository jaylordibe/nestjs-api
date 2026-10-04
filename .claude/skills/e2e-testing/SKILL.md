---
name: e2e-testing
description: This repository's e2e harness — createTestApp/truncateAll, the template-database clone per Jest worker, the per-worker Redis logical database, shared RBAC fixtures, queued-email capture, and error-envelope assertions.
when_to_use: Use when creating or changing test/*.e2e-spec.ts, debugging parallel or Redis-related flakes, testing API contracts, authorization, audit columns, BullMQ handlers, recurring job schedulers, migrations in the isolated test environment, or deciding which tests to run.
user-invocable: false
---

# E2E testing — this repository's harness

The `himoa` standards carry the general testing method — risk-to-assertion
mapping, determinism, and what makes evidence weak or partial. The run cadence
and the test-stack invariants (two stacks, `.env.test`, parallel workers) are in
`AGENTS.md`. This file carries **this repository's harness and contract
assertions**.

Read first: `test/setup/**`, `test/test-harness.e2e-spec.ts`, the closest
existing module spec, and `src/common/errors/README.md`. Read
`references/harness.md` before changing the harness or debugging a suite that
fails without an assertion.

Tests run the real application against real, isolated PostgreSQL and Redis. Do
not replace contract-critical behavior with mocks.

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
that wipes authorization tables. There is no authoritative `role` field on
`users`; do not fabricate one.

Fixtures get their access token from `issueAccessToken` (the session service
login uses), not from `POST /auth/login`. Only auth specs call the login
endpoint.

Account emails are queued and the test app runs no worker. To assert on one,
`captureEmails(app)` then `deliverQueuedEmails(app)` (`test/setup/emails.ts`);
`linkParameter` reads a token out of the emailed link.

## Assertions

**Public API** — assert status, stable `errorCode`, relevant `details`, response
DTO shape, absence of sensitive/audit fields, pagination metadata and order, and
authorization/tenant behavior. **Never assert localized or free-form `message`
text** — messages are free to rotate. The codes themselves are in the error
README; do not copy a list into a spec comment.

**Database and audit columns** — `createdBy`, `updatedBy`, `deletedAt`,
`deletedBy` and other lifecycle columns deliberately hidden from responses are
asserted through `PrismaService`, alongside a separate assertion that the
response omits them.

**Redis and queues** — a spec asserting Redis-backed behavior flushes its own
worker DB first and seeds its own keys. Prefer direct handler tests for a queue
job's domain behavior; use a live worker only when the contract genuinely spans
enqueue-to-processing infrastructure.

Checklists: `references/resource-and-contract-tests.md` (a resource) and
`references/queue-and-scheduled-tests.md` (jobs and schedules).
