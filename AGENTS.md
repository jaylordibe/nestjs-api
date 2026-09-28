# AGENTS.md

Repository truth for every coding agent. Keep it short: only what applies to
most changes. The reasoning behind each rule lives in
[`docs/engineering-conventions.md`](docs/engineering-conventions.md);
situational playbooks live in `.claude/skills/` and `docs/`.

Engineering methodology (gates, risk tiers, evidence language, review lenses,
`/work-item`) comes from the `himoa` plugin and is not restated here.
**Where a framework standard conflicts with this file, this file wins.** It
also supersedes any parent-workspace `CLAUDE.md`. No `tasks/` directory; a
correction worth keeping becomes an edit here.

## Project

NestJS 11 (TypeScript, Express) + Prisma 7 + PostgreSQL + Redis + BullMQ.
JWT auth with DB-backed RBAC + CASL over two scopes (PLATFORM / BUSINESS).
Unversioned `/api/...`; Swagger at `/api/docs`. Package manager: yarn 1,
`yarn.lock` committed.

A **GitHub template**: every new API is forked from it, so a defect here
reaches every fork. Set `SERVICE_NAME` in `.env`; it drives the DB name,
container names and JWT `iss`/`aud`.

Cloud-provider neutral by construction; `docs/deployment/README.md` owns the
runtime contract. One image, two runtimes: `QUEUE_WORKER_ENABLED=false` +
`dist/main.js` (API) or `true` + `dist/worker.js` (worker). Locally one
process does both.

## Canonical commands

| Purpose | Command | Notes |
|---|---|---|
| Install | `yarn install --frozen-lockfile` | |
| Build + type check | `yarn build` | `nest build` typechecks; `postbuild` asserts the artifact |
| Lint / format check | `yarn lint` | Evidence is `lint`, never `lint:fix`; Prettier runs inside it |
| Lint (apply fixes) | `yarn lint:fix` | Closing step only |
| Unit tests | `yarn test` | |
| Integration / e2e tests | `yarn test:e2e` | Starts the test stack itself |
| Single e2e spec | `yarn test:e2e <pattern>` | The cadence during implementation |
| Migration status | `yarn prisma migrate status` | Read-only; applying is human-owned |
| RBAC catalog check | `yarn rbac:check` | Read-only; `rbac:sync` writes |
| Security scan | `yarn audit --level moderate` | CI gate adds `.github/scripts/audit-gate.mjs` |
| Run locally | `yarn start:dev` | Stacks: `yarn stack:up` / `yarn stack:down` |

Every change: `yarn build` + `yarn lint` + the affected e2e specs. Full
`yarn test:e2e` only when a module is complete or on request.

## High-risk paths

| Path pattern | Why |
|---|---|
| `src/modules/auth/*` | Authentication and tokens |
| `src/modules/authorization/*`, `src/common/authorization/*` | RBAC, CASL, tenant isolation |
| `src/common/errors/*` | The `errorCode` contract clients program against |
| `src/modules/queue-admin/*` | Privileged retry/cancel over every tenant's jobs |
| `prisma/schema.prisma`, `prisma/migrations/*` | Schema and applied migrations |

## Architecture

```
src/
  main.ts        HTTP entrypoint (helmet, /api prefix, CORS, gated Swagger)
  worker.ts      queue-only entrypoint into the same AppModule
  app.module.ts  global pipe, serializer, one exception filter, throttler
  config/        configuration.ts (typed) + env.validation.ts (Joi)
  prisma/        PrismaService + soft-delete extension
  common/        leaf layer: authorization catalog, decorators, errors,
                 dto, enums, email/sms/storage, queue, redis, logging, util
  modules/       feature modules; authorization/ holds the global guard,
                 AbilityScopedQueryService and the boot-time integrity gates
prisma/          schema, migrations, scripts/ (one-off), seeds/ (JSON)
test/            e2e specs + setup/ (global DB setup, worker isolation)
```

## Cross-cutting conventions

- **Naming (ESLint `id-length` + `id-denylist`):** full words everywhere,
  including loop variables, callbacks and declared names. No `i`/`j`, no
  `req`/`res`, no truncated morphemes (`Ack`, `Msg`, `Svc`). Allowed:
  `id`, `dto`, `url`, `db`, `ttl`, `jwt`, `otp`, `ip`, generic `T`/`K`.
- **Placement:** services hold behaviour. Static tables go to a co-located
  config module; pure helpers to `src/common/util/*.util.ts` with a spec.
  Delete what you replace; no parallel implementations.
- **Layering:** `src/common/` never imports from `src/modules/` (ESLint).
- **Errors:** throw via the `Errors.*` factory (ESLint-enforced). Clients read
  `errorCode`, never `message`. Prisma errors are mapped once in
  `GlobalExceptionFilter`; services don't catch them.
- **Validation:** whitelist + `forbidNonWhitelisted`; extra fields → 400.
  Boolean query filters need `@Transform(toOptionalBoolean)`.
- **Datetimes:** timestamps use `@IsUtcIsoString()`, date-only fields
  `@IsDateString()`.
- **Responses:** always `new <Resource>ResponseDto(row)`, never raw Prisma
  rows. Sensitive fields need both `@Exclude()` and `@ApiHideProperty()`.
- **Schema:** no DB enums (`String` + TS enum in `src/common/enums/` +
  `@IsEnum()`); booleans are `is*`; every column `@map`s to snake_case.
- **Authorization:** `JwtAuthGuard` + `PermissionsGuard` are global. Every
  handler declares exactly one of `@Public()` / `@AuthenticatedOnly()` /
  `@RequirePermission()`, or boot fails. The permission catalog in
  `src/common/authorization/permission-catalog.ts` is the source; the DB
  projects it. The JWT carries `{ sub, jti }` only.
- **Tenant isolation lives in the query:** scope reads through
  `AbilityScopedQueryService`; never import `@casl/prisma` elsewhere
  (ESLint). 404 when the caller cannot read, 403 when they can read but not
  act. `PermissionCheckService` is only for derived ownership needing a join.
- **Audit fields:** mutating service methods take `actorId` and write
  `createdBy`/`updatedBy`. Privileged actions go through `AuditService.record`.
- **Soft delete:** `prisma.scoped.*` filters top-level reads only; nested
  includes need explicit filters. Never a security boundary.
- **Partial-unique columns** (`users.email`, `users.username`,
  `businesses.slug`): look up with `findFirst`, never `findUnique`.
- **Lists:** five standard endpoints; read handlers are `findPaginated` /
  `findById`, one resource per controller, no unpaginated `GET /all`,
  `perPage` ≤ 100.
- **Config:** `configService.getOrThrow()` only; no `process.env` outside
  `configuration.ts`.
- **Swagger:** paginated handlers use `@ApiPaginatedResponse(T)`; others need
  an explicit `@ApiOkResponse`/`@ApiCreatedResponse({ type })`. Mapped types
  import from `@nestjs/swagger`.
- **Rate limiting:** every `@Public()` or OTP/SMS/email endpoint gets its own
  `@Throttle`.
- **Logging:** pino to stdout only; extend `redact.paths` (bodies) or
  `redactUrlSecrets` (query strings) for new secrets.
- **Health indicators** log the real error and return a fixed string.
- **Providers:** email/SMS/storage adapters are selected by env; a provider
  SDK is imported only by its own adapter. Store `storageKey`, never a URL;
  authorize before issuing a signed URL.
- **Redis:** build every client from `buildRedisConnectionOptions`.
- **Background work:** BullMQ only. Never reintroduce `@nestjs/schedule`.
  Consumers tolerate duplicate delivery and keep `correlationId`.
- **Cycles:** `forwardRef` in both the import and the `@Inject`.
- **TypeScript:** decorated signatures need `import type`
  (`isolatedModules`); cast DB strings to enums before comparing.

## Non-obvious invariants

- **Two local stacks:** dev (5433/6378, `.env`) and test (5434/6380,
  `.env.test`). e2e runs a real `DROP DATABASE`; never point it at dev.
- **`.env.test` is the only test config.** Never add a value to a workflow
  that it already declares.
- **e2e runs in parallel** with per-worker databases and Redis logical DBs;
  a spec never assumes exclusive access outside its own database.
- **Only `QueueWorkerRegistrar` registers BullMQ workers**, gated on
  `QUEUE_WORKER_ENABLED`. No per-processor start/stop; never touch
  `this.worker` outside `startConsuming()`.
- **The local dev DB holds the user's data.** Never reset, drop or re-seed it
  without explicit permission.
- **Never apply migrations during in-progress work.** `yarn build` verifies
  schema changes. Consolidate into one migration and let the user apply it.
  If applied by mistake, un-apply surgically; never `migrate reset`.
- **Never edit an applied migration.** The template ships one `init`
  migration; squash into it only before any deploy has applied it.
- **Storage adapters are `require`d lazily**; don't convert to static imports.
  No adapter accepts a long-lived cloud credential.
- **`.claude/settings.json` is the only enforcement layer.** Mirror every
  `Bash(...)` rule as `PowerShell(...)`; see the conventions doc before
  editing it.

## Consumers

| Consumer | Repository / location | Audience | Owner |
|---|---|---|---|
| (none — internal only: GitHub template with no clients of its own) | | | |

A fork must replace this row with its real consumers before its first
contract change. A contract change (DTO field, `errorCode`, enum value,
status, nullability, pagination, event payload) is done only when every
consumer is updated or recorded as unaffected, with the deploy order stated.

## Deep references

| Task | Where |
|---|---|
| Reasoning behind every rule above | `docs/engineering-conventions.md` |
| New CRUD resource | `resource-pattern` skill, `docs/resource-pattern.md` |
| Permissions, roles, tenant isolation | `authorization` skill, `src/common/authorization/README.md` |
| Auth, JWT, OTP, verification, lockout | `auth-security` skill |
| e2e specs | `e2e-testing` skill |
| Background work (immediate, delayed, recurring) | `src/common/queue/README.md` |
| Error envelope and `ErrorCode` catalog | `src/common/errors/README.md` |
| Deployment contract | `docs/deployment/README.md` |
| Single-VM deployment | `docs/README.md`, `docs/prod/`, `docs/staging/` |
| Which operational controls are enforced | `docs/operations.md` |
