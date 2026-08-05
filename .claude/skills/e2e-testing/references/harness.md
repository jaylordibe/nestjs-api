# E2E harness reference

## Test environment

The repository commits `.env.test`. CI and local e2e runs use the same
configuration and Compose services.

The normal entrypoint is the repository script:

```text
yarn test:e2e [supported Jest filter]
```

Its pretest hook starts the dedicated test stack. Do not start the dev stack as
a substitute and do not shadow `.env.test` with workflow/shell values unless
the repository explicitly requires a diagnostic override.

## Global setup and worker isolation

Global setup:

1. loads test configuration;
2. recreates the test template database;
3. applies migrations to the template;
4. clones a database per Jest worker.

Worker setup derives both database and Redis destinations from the same
`worker-isolation.ts` helpers.

Each worker receives:

- one PostgreSQL database;
- one Redis logical DB.

The configured worker limit must remain below the Redis logical DB capacity.
Redis DB 0 is reserved/protected and must never be flushed by tests.

## `createTestApp`

Use the project helper, not a custom Nest bootstrap.

It:

- compiles the full `AppModule`;
- applies HTTP globals equivalent to production bootstrap;
- listens once on port 0;
- supports scoped provider overrides;
- unregisters cron/interval/timeout callbacks;
- leaves the live queue worker disabled under normal test config.

A bare `init()` can let Supertest create and destroy ephemeral listeners for
each request, producing misleading socket/parse failures. Preserve the
single-listener harness.

## `truncateAll`

Call after app creation and before every isolated scenario.

It:

- truncates public tables;
- preserves `_prisma_migrations`;
- restarts identities;
- cascades;
- flushes only the current worker's Redis DB;
- refuses Redis DB 0.

Because RBAC tables are truncated, seed the authorization catalog after
`truncateAll` before creating principals or calling auth flows that depend on
seeded roles.

## Failure with no failing assertion

A suite that passes alone, fails randomly under the full run, and reports no
failed assertion usually has an unowned background error.

Investigate:

- Redis client reconnect timers after app closure;
- workers/processors not closed;
- unawaited promises;
- provider callbacks after teardown;
- timers/schedulers not removed;
- full stderr from the failing run.

Do not mask it with Jest retries or a global `unhandledRejection` listener.

## Redis ownership

Redis keys outlive an individual test unless the worker DB is flushed.

A spec may assert Redis-derived behavior only when it:

1. calls `truncateAll`;
2. creates the exact keys/jobs/heartbeats it needs;
3. cleans up/awaits workers;
4. does not depend on sibling-spec ordering.
