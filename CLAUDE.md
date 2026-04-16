# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

NestJS API template — NestJS 11 (TypeScript, Express) + Prisma 6 + PostgreSQL. JWT auth with role-based access control (`ADMIN`, `USER`). Intended as a GitHub template: spin up a new repo, set `SERVICE_NAME` in `.env`, and start adding feature modules. URLs are unversioned (`/api/...`) — add Nest URI versioning later if/when a v2 becomes necessary.

## Commands

Package manager: **yarn** (yarn.lock committed).

- `yarn start:dev` / `yarn start:debug` / `yarn start:prod` — watch / debug / compiled
- `yarn build` — `nest build` to `dist/`
- `yarn lint` — ESLint `--fix` over `src`, `test`
- `yarn format` — Prettier write
- `yarn test` — Jest unit tests (`*.spec.ts`, `rootDir: src`); `yarn test path/to.spec.ts` for one file, `yarn test -t "name"` by pattern
- `yarn test:e2e` — uses `test/jest-e2e.json`
- `yarn prisma:generate` — regenerate `@prisma/client` (run after schema edits)
- `yarn prisma:migrate` — `prisma migrate dev` (interactive — creates + applies a migration)
- `yarn prisma:deploy` — `prisma migrate deploy` (production, non-interactive)
- `yarn prisma:studio` — DB browser
- `docker compose up -d` — start the local Postgres 18 + Redis 8 containers. Compose requires `SERVICE_NAME`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`/`DB_PORT`/`REDIS_PORT`/`REDIS_PASSWORD` to be set in `.env` — there are no fallbacks, so a missing key fails fast. With the values shipped in `.env.example` (`SERVICE_NAME=nestjs`, `DB_USER=${SERVICE_NAME}`, `DB_NAME=${SERVICE_NAME}_local`), you get container `nestjs-postgres`, role `nestjs`, and DB `nestjs_local` — i.e. the app connects as a per-service role rather than the generic `postgres` superuser, mirroring the least-privilege pattern used in managed prod (RDS/Cloud SQL). Host ports are **5433** (postgres) and **6378** (redis) to avoid clashing with host-installed instances on the standard 5432/6379; both containers still listen on their canonical ports internally.
  - **Postgres image** is **`postgres:18.3`** (Debian/glibc, fully pinned), **not** Alpine. Postgres 18 is the current latest stable per postgresql.org and is officially recommended for new production deployments. Reasons for this exact pin: (1) managed Postgres providers (RDS, Cloud SQL, Neon, Supabase) all run on glibc, and Postgres text collation is libc-dependent — running Alpine (musl) locally can produce different sort orders / index behavior than prod; (2) pinning to `18.3` (no `-bookworm` suffix needed — bare minor pulls the Debian variant) means an upstream image rebuild can't surprise you with a patch-level skew. Bump the pin deliberately when you bump prod. The cluster is initialized with `POSTGRES_INITDB_ARGS=--encoding=UTF-8 --locale=C.UTF-8` so encoding/collation is deterministic across hosts. `shm_size: 256mb` raises the default 64mb so parallel queries and `work_mem`-heavy plans don't trip "could not resize shared memory segment" errors that wouldn't appear on a real prod box.
  - **Redis image** is **`redis:8.6.2`** (Debian, fully pinned). Started with `--requirepass ${REDIS_PASSWORD}` so it refuses unauthenticated connections (matches managed Redis providers like ElastiCache/Memorystore/Upstash, which always require auth). `--appendonly yes` enables AOF persistence — durable across restarts, matching prod expectations. The Redis 8 license question (relicensed to RSALv2/SSPL/AGPLv3 dual) does **not** affect self-hosted use; only managed-service providers have to care. Connection details are surfaced as both discrete (`redis.host`, `redis.port`, `redis.password`) and as a connection URL (`redis.url`) for clients that prefer one form over the other.
- `docker compose down` (add `-v` to wipe both data volumes — `postgres-data` and `redis-data`)

First-time setup: `docker compose up -d`, copy `.env.example` → `.env` (the defaults already match the compose file — only `JWT_SECRET` needs changing), then `yarn prisma:generate && yarn prisma:migrate dev --name init`.

## Docker

- `docker-compose.yml` runs **only Postgres** so dev keeps using `yarn start:dev` for hot reload against the dockerized DB on `localhost:5432`. POSTGRES_USER/PASSWORD/DB/PORT can be overridden via env or shell vars.
- `Dockerfile` is a 3-stage production build (`deps` → `build` → `runtime`). The `build` stage runs `prisma generate` + `nest build` then prunes to prod deps; `runtime` is `node:24-alpine` + `tini`, runs as non-root `app` user, ships `dist/`, `node_modules/`, and `prisma/` (so `prisma migrate deploy` is available at deploy time). Run migrations as a separate step (init container, deploy hook, etc.) — the entrypoint is just `node dist/main.js`.
- `.dockerignore` excludes `node_modules`, `dist`, `.env*` (except `.env.example`), tests, IDE files.

## Architecture

```
src/
  main.ts              # bootstrap: helmet, prefix /api, ValidationPipe, ClassSerializerInterceptor, AllExceptionsFilter, CORS
  app.module.ts        # ConfigModule (global, Joi-validated) + ThrottlerModule (global APP_GUARD) + PrismaModule + feature modules
  config/              # configuration.ts (typed factory), env.validation.ts (Joi schema)
  prisma/              # @Global() PrismaModule + PrismaService (extends PrismaClient, OnModuleInit/Destroy)
  common/
    decorators/        # Roles, CurrentUser (+ AuthenticatedUser type)
    guards/            # RolesGuard (Reflector-based, reads ROLES_KEY metadata)
    filters/           # AllExceptionsFilter (normalizes to { statusCode, message, error?, path, timestamp })
  modules/
    auth/              # AuthService, AuthController, JwtStrategy, JwtAuthGuard, login/register DTOs (per-route stricter throttle)
    users/             # UsersService (bcrypt hashing, P2002→Conflict), controller, DTOs (Create/Update/Response)
    health/            # @nestjs/terminus: GET /health/liveness (memory) + GET /health/readiness (DB ping via PrismaHealthIndicator)
prisma/schema.prisma   # User model + Role enum, PostgreSQL datasource
```

Endpoints (all under `/api`):
- `POST /auth/register`, `POST /auth/login`, `GET /auth/me` (JwtAuthGuard) — auth-related, including the canonical "who am I?". Login + register override the global throttle with stricter per-route limits (10/min and 5/min respectively) to slow brute-force attempts.
- `GET|POST /users`, `GET|PATCH|DELETE /users/:id` — `JwtAuthGuard + RolesGuard + @Roles(ADMIN)` (the `@Roles` is on the controller, so every endpoint is admin-only)
- `GET /health/liveness` — process-only check (memory heap < 512MB). For k8s liveness probes — should NOT depend on the DB, otherwise a DB blip restarts every pod.
- `GET /health/readiness` — DB reachability check via `SELECT 1`. For k8s readiness probes / load balancer health checks — returns 503 if DB is down so traffic stops being routed.

### Cross-cutting conventions
- **Security headers**: `helmet()` is wired in `main.ts` before any route handler, applying the standard set of OWASP-recommended HTTP headers (CSP, HSTS, X-Frame-Options, etc.). Don't disable without a reason.
- **Rate limiting**: `@nestjs/throttler` is registered globally as an `APP_GUARD` in `app.module.ts`, configured from `THROTTLE_TTL_MS` / `THROTTLE_LIMIT` env vars (default: 100 req / 60s / IP). Override per-route with `@Throttle({ default: { limit, ttl } })` — auth endpoints already do this. Disable per-route with `@SkipThrottle()` (used on `/health/*` so probes never get rate-limited).
- **Validation is global**: `ValidationPipe({ whitelist, forbidNonWhitelisted, transform, transformOptions: { enableImplicitConversion } })`. Add a DTO for every request body — extra fields → 400.
- **Password is never returned**: `UserResponseDto` uses `@Exclude()` and is constructed via `new UserResponseDto(user)`. The global `ClassSerializerInterceptor` strips it. When adding endpoints that return a `User`, wrap it in `UserResponseDto` — don't return raw Prisma rows.
- **Auth payload shape**: JWT carries `{ sub, email, role }`. `JwtStrategy.validate` re-fetches the user **by `sub`** via `UsersService.findByIdOrNull` (non-throwing, so a missing user surfaces as 401, not 404), checks `isActive`, and returns `AuthenticatedUser` (the `request.user` shape). Use `@CurrentUser()` to read it; it returns `AuthenticatedUser`, NOT a full `User`. If you need the full row in a handler, call `usersService.findById(currentUser.id)`.
- **Role-based access**: `@UseGuards(JwtAuthGuard, RolesGuard) @Roles(Role.ADMIN)` on the handler/controller. `RolesGuard` allows when no `@Roles()` is set, so `JwtAuthGuard` alone = "any authenticated user".
- **Prisma access** goes through `PrismaService` (DI-injected). The module is `@Global()` — no need to re-import.
- **Unique-constraint violations** in user mutations should be mapped to `ConflictException` by checking `err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'` (see `users.service.ts` for the pattern).
- **Config access**: `configService.getOrThrow<T>('jwt.secret')` etc. — keys are dot-paths into `configuration.ts`. Don't read `process.env` directly outside `configuration.ts`.
- **`SERVICE_NAME` is the single source of truth** for the service identifier. It's exposed at `configService.get('serviceName')` and used to derive `DB_NAME` (which defaults to `${SERVICE_NAME}_local` via dotenv-expand — the `_local` suffix keeps the dev DB visually distinct from any same-named DB on a shared host). `DB_NAME` then drives the Postgres database name in compose and the `${DB_NAME}` slot in `DATABASE_URL`. Change `SERVICE_NAME` → DB name and URL follow automatically; override `DB_NAME` explicitly if you ever need the DB name to diverge (e.g., a parallel branch DB or a non-`_local` env). The compose container name uses `SERVICE_NAME` directly. `db.name` is also exposed at `configService.get('database.name')` for app-level use. Both `@nestjs/config` (`expandVariables: true`) and the Prisma CLI support `${VAR}` expansion in `.env`; modern docker-compose (v2+) interpolates variables within `.env` too.

### Decorator-typed parameters and `isolatedModules`
TypeScript here has `isolatedModules: true` + `emitDecoratorMetadata: true`. Types referenced in **decorated** function signatures (e.g. `@CurrentUser() current: AuthenticatedUser`) must be imported via `import type` (or a separate type-only import line) — combining a value + type import in one statement breaks the build with TS1272. Pattern used in this repo:
```ts
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
```

### `@nestjs/jwt` `expiresIn` typing quirk
`JwtModuleOptions.signOptions.expiresIn` is typed as `number | StringValue` (a literal-template type from `ms`). Passing a runtime `string` from `ConfigService` requires `as unknown as number` (see `auth.module.ts`). If you change the cast, you'll re-introduce a TS error.

## Testing

**Unit tests** live next to the code as `*.spec.ts` (none yet — add as needed).

**E2E (feature) tests** live in `test/` as `*.e2e-spec.ts` and run **against a real Postgres test DB**, not against mocks. The whole point is to assert on actual responses produced by the real wire: HTTP → controller → service → Prisma → Postgres → JSON.

### Test harness (`test/setup/`)

- **`global-setup.ts`** — runs once before the test suite. Loads `.env.test`, connects to the `postgres` admin DB on the same Postgres container, **terminates any lingering connections**, **drops and re-creates** `${SERVICE_NAME}_test` (e.g. `nestjs_test`), then runs `prisma migrate deploy` against the fresh DB. So **every `yarn test:e2e` invocation starts from zero** — guaranteed schema parity with the migration history, no stale state from a previous run, and an implicit "do migrations work from empty?" gate on every run. Cost: ~2–3 seconds per run today, scales linearly with migration count.
- **`load-env.ts`** — runs at the start of each test process (Jest `setupFiles`). Loads `.env.test` with `dotenv` + `dotenv-expand`. Uses `override: false` (dotenv default) so CI's `env:` block always wins.
- **`test-app.ts`** — `createTestApp()` boots the full `AppModule` and applies the same global setup as `main.ts` (helmet, prefix `/api`, ValidationPipe, ClassSerializerInterceptor, AllExceptionsFilter). Tests should call this in `beforeAll`, not import individual modules — the goal is parity with prod.
- **`db.ts`** — `truncateAll(app)` runs `TRUNCATE ... RESTART IDENTITY CASCADE` on every public-schema table (skipping `_prisma_migrations`). Call it in `beforeEach` for test isolation.

### Running locally

```bash
docker compose up -d            # need postgres up
yarn test:e2e                   # globalSetup creates nestjs_test on first run
```

`.env.test` is committed (no real secrets) and points to the same container as `.env` but uses DB `${SERVICE_NAME}_test`. The throttler is **disabled in test env** (via `skipIf` in `app.module.ts`) so per-route limits like `POST /auth/login` (10/min) don't trip during a 3-line test sequence.

### Adding a new e2e spec

1. Create `test/<resource>.e2e-spec.ts`.
2. `beforeAll`: `app = await createTestApp()`. `afterAll`: `await app.close()`.
3. `beforeEach`: `await truncateAll(app)`.
4. Use `request(app.getHttpServer()).post(...).send(...).expect(...)` — full path including `/api` prefix.
5. To seed an `ADMIN`, write directly via `app.get(PrismaService).user.create({ ... role: 'ADMIN' })` then log in via `POST /api/auth/login` to get a token (the `register` endpoint always creates `USER` role — see `RegisterDto`).

### CI

`.github/workflows/ci.yml` runs the same flow on every PR + every push to `main`: lint → build → unit tests → e2e tests. Postgres 18.3 is provisioned as a service container; env vars are set inline in the workflow's `env:` block (so `.env.test` is silently ignored — its values would be overridden anyway). No Redis service is provisioned because the app doesn't yet connect to Redis; only the env vars (which Joi validates) are present.

## Lint/format

ESLint uses `typescript-eslint` **recommendedTypeChecked** (type-aware — lint is slow on large diffs). Local overrides in `eslint.config.mjs`:
- `@typescript-eslint/no-explicit-any` — off
- `@typescript-eslint/no-floating-promises` — warn
- `@typescript-eslint/no-unsafe-argument` — warn
- Prettier runs as an ESLint rule with `endOfLine: "auto"`

Two recurring rule encounters worth knowing about:
- `@typescript-eslint/no-unsafe-enum-comparison` — fires when comparing an enum (e.g. `HttpStatus.INTERNAL_SERVER_ERROR`) to a numeric literal. Cast: `(status as number) >= 500`.
- `@typescript-eslint/no-unsafe-member-access` on supertest — `res.body` is `any`. Narrow it: `const body = res.body as { status?: string };`.

## Prisma 7 setup

This scaffold runs on **Prisma 7** with the **`@prisma/adapter-pg`** driver adapter — required by Prisma 7. Three things to know:

- **`prisma/schema.prisma`** has only `provider = "postgresql"` in its `datasource` block — no `url`. The connection URL lives in `prisma.config.ts` (loaded by the Prisma CLI for `migrate`/`generate`/`studio`) and is passed to the runtime client via the adapter constructor in `src/prisma/prisma.service.ts`.
- **`prisma.config.ts`** loads `.env` (with `dotenv-expand` so `DATABASE_URL` interpolation works) and exposes `{ schema, migrations.path, datasource.url }` to the CLI. The Prisma CLI auto-discovers this file at the repo root.
- **`PrismaService`** now has a constructor that injects `ConfigService`, builds a `PrismaPg({ connectionString })` adapter, and passes it to `super({ adapter })`. The `extends PrismaClient` pattern still holds; the only change vs. Prisma 6 is the constructor.

The `pg` package is a **runtime dependency** (the adapter wraps a `pg.Pool`), not just a test devDep. Bumping the adapter or `pg` should be done together to avoid version skew.
