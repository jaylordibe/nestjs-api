---
name: nestjs-e2e-test
description: Use when writing or updating e2e specs (test/*.e2e-spec.ts) — the real-Postgres harness, createTestApp, truncateAll, seeding an admin user, required coverage per resource, asserting the error envelope (errorCode), and the rule about reading audit columns from the DB rather than the API body.
---

# E2E testing

**E2E** (`test/*.e2e-spec.ts`) run against a real Postgres test DB — no mocks.

## Harness (`test/setup/`)

The suite runs **in parallel** (`maxWorkers: 50%`), so a spec must never assume exclusive access to anything outside its own database.

- `global-setup.ts` — once before the suite: loads `.env.test`, drops + recreates `${SERVICE_NAME}_test` as a **template**, runs `prisma migrate deploy` against it, then clones it per jest worker (`CREATE DATABASE … TEMPLATE …`, so migrations run exactly once however many workers there are). Fails loudly above `MAX_PARALLEL_WORKERS` (15 — Redis ships 16 logical DBs and index 0 belongs to local dev).
- `worker-isolation.ts` — the naming helpers the writer (`global-setup`) and the reader (`load-env`) both derive from, so the two can never disagree about where a worker's data lives.
- `load-env.ts` — Jest `setupFiles`: `.env.test` via dotenv + dotenv-expand, `override: false` (CI / shell env wins). Then **repoints this worker's `DATABASE_URL` and `REDIS_URL`** at its own database and its own Redis logical DB — that part deliberately overrides, or every worker would share one and truncate the others' rows.
- `test-app.ts` — `createTestApp(configure?)` boots the full `AppModule` + applies the same globals as `main.ts` (helmet, `/api` prefix). Other globals via `APP_*` providers apply automatically. It also:
  - takes an optional `(builder) => builder` hook for `.overrideProvider(...)` in a single spec;
  - calls **`listen(0)`, not a bare `init()`** — see the comment in the file. A non-listening server makes supertest bind and tear down an ephemeral port per request, which is the root cause of the classic random `socket hang up` / `Parse Error: Expected HTTP/` flakiness;
  - **unregisters every `@Cron`/`@Interval`/`@Timeout`**, so a spec straddling a wall-clock boundary can't have a background job mutate the data it is asserting on.
- `db.ts` — `truncateAll(app)` runs `TRUNCATE ... RESTART IDENTITY CASCADE` on every public table (skips `_prisma_migrations`) **and flushes this worker's Redis logical DB**. It refuses to flush index 0. Call in `beforeEach`.

`.env.test` is committed. Throttler disabled in test env via `skipIf` (in-memory storage, no live Redis required for rate limiting). `QUEUE_WORKER_ENABLED=false`, so no spec gets a live queue worker acting on the database its assertions read.

## Redis state is shared within a worker — own it or don't assert it

Postgres is truncated per spec; Redis is flushed by the same `truncateAll`. A spec that asserts on Redis-backed state but never calls `truncateAll` is asserting on **whatever a sibling spec left behind** (keys outlive a spec up to their TTL), and will pass or fail on ordering.

So: assert Redis-derived behaviour only in a spec that flushes first and seeds the state itself. `health.e2e-spec.ts` asserts readiness (deterministic) but deliberately leaves `GET /api/health/workers` to `queue.e2e-spec.ts`, which owns the heartbeat key.

## Adding an e2e spec

1. `beforeAll: app = await createTestApp()`, `afterAll: await app.close()`.
2. `beforeEach: await truncateAll(app)`.
3. `request(app.getHttpServer()).post('/api/...').send(...).expect(...)`.
4. Seed principals via the SHARED fixtures in `test/setup/rbac.ts` — never hand-roll them:
   - `seedRbacCatalog(app)` in `beforeEach`, **after** `truncateAll` (which wipes `roles`/`permissions`; without them even `POST /auth/register` fails, because a new user is granted PLATFORM_USER in the same transaction).
   - `createPlatformAdmin(app)` → holds `manage all`.
   - `createRegularUser(app, email)` → PLATFORM_USER only (self-service grants).
   - `createPlatformUser(app, { email, roles: [SeededRoleName.PLATFORM_SUPPORT] })` → any staff role.
   - `registerAndLogin(app, email)` when the spec is exercising the register flow itself.

   There is no `role` column on `users` and no `Role` enum. Authorization lives in `user_roles` / `business_members`. These helpers stamp `emailVerifiedAt` directly, because register leaves it null and login is blocked by the verification gate.

## Required coverage per resource

Six endpoints + access control (401 unauthenticated, 403 wrong role) + pagination (meta shape, invalid params → 400).

- **Audit columns** (`createdBy`/`updatedBy`/`deletedAt`/`deletedBy`) are stripped from the API — assert on them by reading the DB directly: `app.get(PrismaService).<model>.findUniqueOrThrow(...)`, not the response body.
- **Scheduled jobs** (`@Cron`): call the public work method directly; mock the side-effect collaborator and assert the dedupe column flips. Never test cron timing.
- **Queue jobs**: assert the HANDLER, not the queue. Call `handler.handle(payload)` directly and check each branch — completed, skipped-because-gone, skipped-because-superseded. The infrastructure around it (validation, versioning, retry classification, correlation, lifecycle logging) is already covered once, by `queue.e2e-spec.ts`; re-proving it per job is duplication. Only reach for a live worker when the job's contract genuinely spans the round trip, and then follow the pattern below.

## Exercising a live queue worker

`.env.test` disables the worker, so a spec that needs one flips the flag **before** `createTestApp` compiles the module (the config factory re-runs per compiled `AppModule`) and restores it in `afterAll`. See `queue.e2e-spec.ts`.

Two rules that spec exists to demonstrate:

- **Poll, never sleep.** Queue work is asynchronous by definition, so assertions use a `waitUntil(condition, description)` helper. A fixed sleep is either flaky or slow, and usually both.
- **Drain before truncating.** `truncateAll` flushes the whole logical Redis DB, BullMQ's keys included. A job mid-flight when its keys vanish fails with `Missing key for job N`. `await processor.worker.pause()` → `truncateAll` → `processor.worker.resume()`.

## Asserting the error envelope

Every error returns `{ statusCode, error, errorCode, message, details, path, timestamp, requestId }`. **Assert on `errorCode` (stable), not `message` (free to rotate).**

```ts
const res = await request(app.getHttpServer()).get('/api/users/<missing-uuid>')...expect(404);
expect(res.body.errorCode).toBe('RESOURCE_NOT_FOUND');
expect(res.body.details).toEqual({ resource: 'User' });
```

Common codes: `VALIDATION_FAILED` (400), `INVALID_CREDENTIALS` / `EMAIL_NOT_VERIFIED` / `CURRENT_PASSWORD_INCORRECT` (401), `INSUFFICIENT_ROLE` (403), `RESOURCE_NOT_FOUND` (404), `UNIQUE_CONSTRAINT_VIOLATION` (409). Full catalog: `src/common/errors/README.md`.

## Shared specs stay general

Keep repo-wide specs general — don't embed resource-specific assertions in them; document conventions in `CLAUDE.md` instead.

## Test cadence — when to run the full suite

The full `yarn test:e2e` drops + recreates the DB and runs every spec — it's slow. While a module is still being built piece by piece, run only the **affected** spec(s) (e.g. `yarn test:e2e users.e2e`) alongside `yarn build` + `yarn lint`. Run the **full** suite only when a module is complete, the user explicitly asks, or right before a staging deploy. When a module looks finished, **ask** *"Should we run the full e2e suite now?"* rather than running it unprompted.

## Local infra note

`docker compose up -d` must be running (Postgres + Redis). If host ports 5433/6378 are taken by another project on the same machine, bring up this stack on alternate ports (`DB_PORT=5434 REDIS_PORT=6380 docker compose up -d`) and run e2e with matching `DATABASE_URL` / `REDIS_URL` overrides — `load-env.ts` uses `override: false`, so shell env wins over `.env.test`.
