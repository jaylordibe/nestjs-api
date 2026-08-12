# CLAUDE.md

Guidance for Claude Code working in this repo. **This file is the always-on core** — it's loaded into context on every request, so it holds only what applies to *almost every* change. Situational, deep playbooks live in **skills** (`.claude/skills/`) and **docs** (`docs/`); load them when the task calls for them rather than duplicating their content here.

**Engineering methodology comes from the `engineering-framework` plugin and is not restated here.** The gates, risk tiering, evidence language, review lenses, and human-owned-operations policy are the plugin's. Where a generic framework standard conflicts with a rule in this file, **this file wins** — it describes a system that actually exists.

This file supersedes any parent-workspace `CLAUDE.md` for work in this repository. This repository has no `tasks/` directory — do not create one. Corrections worth keeping become an edit to this file, not a lessons log.

## Naming (ESLint-enforced)

Variables, parameters, functions, methods, classes, and types all read as full, intention-revealing domain words. No single-letter or throwaway locals (`b`, `r`, `d`, `e`, `x`), no cryptic abbreviations (`errMsg`, `cfg`, `tmp`, `usr`, `req`, `res`), no vague placeholders (`data`, `item`, `obj`, `val`, `thing`), and **no `i`/`j` loop counters** — iterate with `for…of` / `.map`/`.entries()` over a named element, or name the index (`rowIndex`, `pageIndex`). Loop bodies and callbacks are **not** an exception — `for (const user of activeUsers)` and `.map((device) => …)`, never `for (const u of users)` / `.map((d) => …)`. Spell out Express handler params too: `request`/`response` (`next` is fine). The ONLY abbreviations allowed are repo-wide domain idioms already established here (`id`, `dto`, `url`, `db`, `ttl`, `jwt`, `otp`, `ip`) and single-letter generic type params (`T`, `K`).

**The same standard binds *declared* names — functions, methods, classes, types, enums, DTOs, files.** No truncated morphemes *anywhere* in an identifier — `Ack`→`Acknowledgement`, `Msg`→`Message`, `Mgr`→`Manager`, `Ctrl`→`Controller`, `Svc`→`Service`, `Repo`→`Repository`, `Calc`→`Calculate`, `Ctx`→`Context`, `Gen`→`Generate`, `Addr`→`Address`, `Num`→`Number`, `Val`→`Value`. So `OperationAcknowledgementDto`, never `OperationAckDto`; `formatServiceDateCompact`, never `fmtSvcDate`.

This is enforced by `id-length` + `id-denylist` in `eslint.config.mjs`, not by convention alone.

## Repository-specific engineering rules

- **Separate data, behavior, and pure helpers.** A service/controller holds **behavior**, never large static lookup tables, registries, or config arrays dangling above the class — those move to a co-located config module (e.g. `*-registry.ts`) and are imported. Pure, reusable functions (string/date/enum/number transforms) live in `src/common/util/*.util.ts` with a `*.util.spec.ts`, never inline at the top of a service. If a reader must scroll past static data or a helper to reach the class, it's misfiled.
- **Single source of truth.** One filter, one envelope, one factory, one config file. Two files doing the same thing is a smell — consolidate.
- **Make conventions self-enforcing.** New conventions ship with a guardrail (ESLint rule, type contract, central factory, exhaustive switch, boot-time gate). Documentation alone is not enough — this repo already fails to boot on authorization drift, and that is the standard to match.
- **Delete what you replace.** Old filters, old throws, old code paths — gone. No `// removed` comments, no `// legacy` directories, no parallel implementations.
- **Verification commands.** `yarn build` + `yarn lint` + the **affected** e2e spec(s) on every change. **Evidence uses `yarn lint`, never `yarn lint:fix`** — `eslint --fix` exits 0 after silently rewriting whatever it repaired, so the fixing form cannot fail and proves nothing. Prettier is enforced inside `lint` via the `prettier/prettier` rule, so `lint` is the formatting gate too. Run the **full** `yarn test:e2e` only when a module is complete or the user asks. The e2e suite runs **in parallel** (`maxWorkers: 50%`): `globalSetup` migrates one template database and clones it per worker, and each worker gets its own Redis logical database (`test/setup/worker-isolation.ts`) — so specs must never assume exclusive access to anything outside their own database.

## Project

NestJS 11 (TypeScript, Express) + Prisma 7 + PostgreSQL + Redis. JWT auth with DB-backed RBAC + CASL over two scopes (PLATFORM / BUSINESS). GitHub template: set `SERVICE_NAME` in `.env`, add feature modules. URLs unversioned (`/api/...`). Swagger at `/api/docs`.

**The API/worker split is enforced by the framework, not by a runtime `if`.** `QueueModule` sets `extraOptions: { manualRegistration: true }` on the BullMQ root, and `QueueWorkerRegistrar` is the ONLY caller of `BullRegistrar.register()` — gated on `QUEUE_WORKER_ENABLED`. An API instance therefore constructs no `Worker` at all. Do not reintroduce per-processor start/stop logic, and do not access `this.worker` outside `startConsuming()`: it does not exist before registration and throws.

**Cloud-provider neutral, by construction.** The application depends on generic capabilities — HTTP runtime, PostgreSQL, a Redis-compatible backend, object storage, runtime-injected env secrets, a worker runtime, stdout logging, HTTP health checks — and nothing else. No cloud SDK appears outside a storage adapter; no secret-manager SDK appears at all. The full contract is `docs/deployment/README.md`. **Two deployed runtimes, one image, one variable.** `QUEUE_WORKER_ENABLED=false` + `node dist/main.js` is the HTTP API: it serves traffic, enqueues jobs, and neither consumes them nor installs recurring schedules. `QUEUE_WORKER_ENABLED=true` + `node dist/worker.js` is the worker: it consumes every queue and owns the BullMQ job schedulers. **BullMQ is the ONLY background-work mechanism** — immediate, delayed, recurring, retried. `@nestjs/schedule` is not a dependency and must not be reintroduced: an in-process cron fires once per process, which a horizontally-scaled API multiplies and a restart silently skips. Locally one process does both.

Package manager: **yarn** (yarn.lock committed). Scripts: `start:dev`, `start:prod`, `start:worker`, `build`, `lint`, `lint:fix`, `test`, `test:e2e`, `stack:up`, `stack:down`, `prisma:generate`, `prisma:migrate`, `prisma:deploy`, `prisma:seed`, `prisma:studio`.

**Two container stacks, one `docker-compose.yml`, one definition each for Postgres 18.3 + Redis 8.6.2 + MinIO** (MinIO is S3-compatible object storage, so the `s3` adapter is exercised for real by `test/storage-s3.e2e-spec.ts` instead of only being constructed — and a developer can run `STORAGE_PROVIDER=s3` locally with no cloud account) — which one you get is decided by the env file:

| Stack | Command | Containers | Ports |
|---|---|---|---|
| dev | `docker compose up -d` (reads `.env`) | `${SERVICE_NAME}-postgres` / `-redis` | **5433** / **6378** |
| test | `docker compose --env-file .env.test up -d` | `${SERVICE_NAME}-test-postgres` / `-redis` | **5434** / **6380** |

`yarn stack:up` starts both; `yarn test:e2e` starts the test stack itself via the `pretest:e2e` hook, so it needs no setup. They run side by side with separate volumes and networks — deliberate, because `globalSetup` issues a real `DROP DATABASE` on every e2e run and must not be able to reach dev data.

**`.env.test` is the single source of truth for test config** — CI defines no env vars and no service containers of its own; `.github/workflows/test.yml` loads this same file and starts these same compose services, so what passes locally is what runs in CI. Never add a value to a workflow that `.env.test` already declares: a workflow `env:` block silently shadows the file (`dotenv` never overrides an existing `process.env`), which is how CI ends up testing a different configuration than every developer.

`SERVICE_NAME` is the single source of truth — drives `DB_NAME` default (`${SERVICE_NAME}_local`), container name, and JWT `iss`/`aud`.

## Canonical commands

Everything runs on the host; only PostgreSQL and Redis live in containers.

| Purpose | Command | Notes |
|---|---|---|
| Install | `yarn install --frozen-lockfile` | |
| Lint / format check | `yarn lint` | **The gate.** Prettier is enforced inside it via `prettier/prettier` |
| Lint (apply fixes) | `yarn lint:fix` | Closing step while implementing — **never** validation evidence |
| Build + type check | `yarn build` | `nest build` typechecks; `postbuild` asserts the artifact contract |
| Unit tests | `yarn test` | |
| E2E tests | `yarn test:e2e` | Starts the test stack itself via `pretest:e2e` |
| Single e2e spec | `yarn test:e2e <pattern>` | The cadence during implementation |
| Prisma client | `yarn prisma:generate` | Runs inside `yarn build` |
| Migration status | `yarn prisma migrate status` | Read-only; **applying** migrations is human-owned |
| RBAC catalog check | `yarn rbac:check` | Read-only; `rbac:sync` writes |
| Dependency advisories | `yarn audit --level moderate` | The CI gate adds `.github/scripts/audit-gate.mjs` |
| Start / stop stacks | `yarn stack:up` / `yarn stack:down` | `stack:down` never passes `-v` |

**There is no separate type-check script** — `yarn build` is it. Report type checking as covered by the build, never as a missing gate.

## Consumers

_(none — this repository is the GitHub template every new API project is forked from, so it has no clients of its own. **A fork must replace this paragraph with a table of its real consumers — repo, audience, owner — before its first contract change.**)_

A **contract change** — any request/response DTO field, `errorCode`, enum value, HTTP status, required/optional/null change, pagination or ordering change, or event payload — is not done when this API compiles. It is done when every consumer in this table has either been updated or been explicitly recorded as unaffected, with the deployment order stated. Cross-repo work is a **handoff note plus a blocker**, never a sentence buried in a summary; if the other repo is owned by someone else, say who and what must ship first.

**In a fork, an unfilled table makes every contract change report "no consumers" and cross-repository breakage ship silently.** An unfilled table and a deliberately empty one are indistinguishable to every later reader, which is why the row above states the reason rather than sitting blank.

## Architecture

```
src/
  main.ts              # bootstrap: helmet, prefix /api, trust proxy, CORS, Swagger (gated), shutdown hooks
  worker.ts            # 2nd entrypoint into the SAME AppModule, no HTTP server — pure queue consumer
  app.module.ts        # ConfigModule + ThrottlerModule + PrismaModule + QueueModule + features;
                       # APP_PIPE (ValidationPipe), APP_INTERCEPTOR (ClassSerializerInterceptor),
                       # APP_FILTER (GlobalExceptionFilter), APP_GUARD (ThrottlerGuard)
  config/              # configuration.ts (typed factory), env.validation.ts (Joi)
  prisma/              # @Global() PrismaModule + PrismaService + soft-delete extension
  common/
    authorization/     # permission-catalog.ts (SINGLE SOURCE OF TRUTH), subject-key.ts, app-ability.ts, README.md
    decorators/        # RequirePermission, AuthenticatedOnly, Public, CurrentUser (+ AuthenticatedUser), CurrentAbility, IsUtcIsoString
    filters/           # GlobalExceptionFilter (single unified filter)
    errors/            # ErrorCode enum, Errors factory, app-exception types, README (the error contract)
    pipes/             # ParseJsonPipe (multipart JSON-string body field)
    dto/               # MetaQueryDto (page/perPage/search/sortBy/sortOrder + buildOrderBy), PaginatedResponseDto<T>
    enums/             # RoleScope, PermissionOwnership, SeededRoleName, Gender, OtpPurpose, AppPlatform, DeviceType, DeviceOs
    email/  sms/  storage/   # @Global() provider abstractions (stub + real adapters)
    audit/  redis/
    queue/             # @Global() BullMQ layer — queue/job/recurring-schedule registries,
                       # QueueProducerService, QueueProcessor base, handler registry, README.md
    constants/         # shared literal tables (HHMM_PATTERN, …)
    logging/           # pino-http options + the redactUrlSecrets req serializer
    telemetry/         # TelemetryShutdownService — flush ordering on shutdown hooks
    util/              # pure helpers + co-located *.util.spec.ts
  modules/
    authorization/     # @Global: AbilityFactory, PermissionLoaderService (grants cache),
                       # AbilityScopedQueryService (the ONLY caller of accessibleBy),
                       # guards/PermissionsGuard (global APP_GUARD, fails closed),
                       # PermissionCatalogIntegrityService + RouteAuthorizationAuditService (boot gates)
    queue-admin/       # ADMINISTRATIVE control surface over BullMQ — inspect, retry,
                       # cancel jobs. Every handler is @RequirePermission(…, 'QueueJob',
                       # { administrative: true }); treat changes here as high risk.
    enums/             # read-only projection of src/common/enums/ for clients
    auth/ users/ roles/ businesses/ (members, customers) audit-logs/ app-versions/ device-tokens/ health/ public/
prisma/schema.prisma   # PostgreSQL datasource
prisma/scripts/        # one-off ts-node admin scripts (backfills, imports)
prisma/seeds/          # static seed data JSON consumed by prisma/seed.ts
```

## Cross-cutting conventions (apply to almost every change)

- **Error envelope + factory**: every error emits `{ statusCode, error, errorCode, message, details, path, timestamp, requestId }`. **Throw via the `Errors.*` factory** (`src/common/errors/errors.ts`), never `new BadRequestException(...)` / `NotFoundException` / `UnauthorizedException` / etc. directly — **ESLint enforces this** (`no-restricted-syntax`). Clients (web + mobile) program against `errorCode` (stable, machine-readable), never `message` (free to rotate/localize). Adding a scenario + full contract + the client auto-logout rule: `src/common/errors/README.md`.
- **Prisma errors**: handled by the single global filter (P2002 → 409 `UNIQUE_CONSTRAINT_VIOLATION` with `details.field`, P2003 → 400 `FK_REFERENCE_INVALID`, P2025 → 404 `RESOURCE_NOT_FOUND`). Services don't try/catch these.
- **Validation**: global `ValidationPipe({ whitelist, forbidNonWhitelisted, transform, transformOptions: { enableImplicitConversion: true } })`. Extra fields → 400. Query numbers auto-convert. Class-validator failures route through `exceptionFactory` → `Errors.validationFailed(flattenValidationErrors(errors))` → 400 `VALIDATION_FAILED` with `details: { field, constraints }[]`, keyed by form-name path (`address.street`, `passengers[0].firstName`). Cross-field rules: `@Match('other')` (confirm-password/email) and `@IsAfterTime('startField')` (HH:mm ordering); `HH:mm` fields validate against `@Matches(HHMM_PATTERN)` (`common/constants/time.constants.ts`). Boolean **query** filters must use `@Transform(toOptionalBoolean)` + `@Type(() => String)` (`common/util/query-boolean.util.ts`) — implicit conversion otherwise coerces the string `'false'` to `true`.
- **Datetime inputs**: timestamp fields use `@IsUtcIsoString()` (`src/common/decorators/is-utc-iso-string.decorator.ts`) — accepts only `…Z`/`…±00:00`, never `@IsDateString()`. Calendar-date-only fields (`birthday`, `fromDate`/`toDate`) keep `@IsDateString()`.
- **Response serialization**: global `ClassSerializerInterceptor`. Always return `new <Resource>ResponseDto(row)` — never raw Prisma rows (secrets leak).
- **`@Exclude()` + `@ApiHideProperty()`**: sensitive response fields need **both** (class-transformer runtime vs Swagger build-time are independent layers).
- **No DB enums**: enum-like columns are `String`; constrain via TS enum in `src/common/enums/` + `@IsEnum()`. UPPER_SNAKE keys, lowercase_snake values; cast at the DB→app boundary (`role.scope as RoleScope`). Changing a TS enum needs no migration.
- **Database is snake_case; code is camelCase.** Every table is `@@map`'d to snake_case plural, and every camelCase field is `@map`'d to a snake_case column. Postgres folds unquoted identifiers to lowercase, so a camelCase column forces `"deletedAt"` in every hand-written query — and worse, an *unquoted* `deletedAt` silently resolves to a different identifier (`deletedat`). Prisma's generated client, DTOs, and API responses stay camelCase; the mapping is transparent and requires no application code. **A new model's fields must carry `@map` unless already all-lowercase.**
- **Boolean columns are `is`-prefixed**: every `Boolean` DB column (and its DTO field) reads as a predicate — `isActive`, `isFeatured`, `isEnabled`, `isVerified` — never bare nouns/verbs (`enabled`, `verified`, `active`). Keeps the schema self-describing and greppable.
- **Authorization (RBAC + CASL)**: `JwtAuthGuard` and `PermissionsGuard` are **global** `APP_GUARD`s — controllers never apply them. Every handler declares **exactly one** of `@Public()` / `@AuthenticatedOnly()` / `@RequirePermission(action, subject, opts)`, or the app **refuses to boot** (`RouteAuthorizationAuditService`). Permissions are a catalog in `src/common/authorization/permission-catalog.ts`; the DB is a *projection* of it (boot fails on drift; `yarn prisma:seed` / `yarn rbac:check`). A permission row stores **what** (action + subject), never a condition — `AbilityFactory` injects the **where** from `scope` + `ownership`. `@CurrentUser()` returns `AuthenticatedUser` (id/email only — **no role**); `@CurrentAbility()` returns the compiled CASL `AppAbility`. JWT carries `{ sub, jti }` only; grants are re-read per request (Redis-cached, explicitly invalidated) so a revoked role bites immediately, not at token expiry.
- **Tenant isolation lives in the QUERY, not the guard.** A guard runs before the row is loaded and CASL ignores conditions on a subject-*type* check, so it can only prove a rule *exists*. Scope every read through `AbilityScopedQueryService` (`buildWhere` / `buildWhereOrEmpty` / `buildRecordWhere`). **Never import `@casl/prisma` elsewhere — ESLint blocks it**: Prisma silently drops an empty `OR: []` nested inside `AND`, so the obvious merge returns *every row* to a caller with no rules. **404 when the caller cannot read the record** (a 403 would confirm it exists); **403 when they can read it but may not act on it**. Full contract: `src/common/authorization/README.md`.
- **Audit fields**: `createdBy`/`updatedBy` do **not** auto-populate. Every mutating service method takes `actorId: string | null` and writes it; controllers pass `@CurrentUser().id` (or `null` for unauthenticated creates).
- **Audit log + request envelope**: record privileged/security actions via `AuditService.record({ action, actorId, targetUserId, metadata })` — best-effort (a failed write never blocks the operation). Inside an HTTP request a server-vouched `metadata.request` envelope (requestId/ip/userAgent/method/path + parsed browser·os·device + Cloudflare country·ray) is auto-merged by the `ClsModule` middleware (`app.module.ts`); cron/script calls (no request context) skip it cleanly. Don't pass a caller `metadata.request` key — it's overwritten. The `requestId` matches the pino `X-Request-Id` for the same request.
- **Disposable-email blocking**: `isDisposableEmail()` (`common/util/disposable-email.util.ts`, backed by `disposable-email-domains`) gates auth — register **silently drops** (byte-identical 201/body, no user row, audited), login collapses to `INVALID_CREDENTIALS` behind a timing-safe dummy bcrypt (audited). Never surface the block to the caller (no enumeration). `Errors.emailDomainDisallowed(domain)` exists for non-auth contexts where surfacing the reason is acceptable.
- **Soft-delete + uniqueness**: a plain `@unique` lets a soft-deleted row hold its identifier hostage forever. `users.email`, `users.username`, and `businesses.slug` therefore carry **no `@unique`** in `schema.prisma`; they get partial unique indexes (`WHERE deleted_at IS NULL`) in the init migration. Prisma can't see a partial index, so those columns are **not unique selectors** — look them up with **`findFirst`, never `findUnique`**. (This is about the partial index, not soft delete: `findUnique` on a real unique column works fine, and the soft-delete filter now injects `deletedAt: null` straight into its `where` via Prisma's `extendedWhereUnique`.) **Do not "fix" this with `@@unique([email, deletedAt])`** — `NULL != NULL` in SQL, so that constraint accepts two live rows with the same email while still reporting itself unique. `findFirst` on the partial index produces the same index scan `findUnique` would.
- **Prisma access**: through `PrismaService` (`@Global()`). `prisma.scoped.*` auto-injects `deletedAt: null` for soft-delete models on **top-level reads only** — Prisma extensions cannot intercept nested reads, so an `include` of a soft-delete model returns soft-deleted rows unless you filter it explicitly (to-many: `where` inside the include; to-one: filter the parent, since Prisma has no `where` on a to-one include). Soft delete is a convenience, **never a security boundary** — authorization boundaries live in `AbilityScopedQueryService`. Raw `prisma.*` sees soft-deleted rows (admin/forensic/recovery). Adding a soft-delete model + the full mechanism: `resource-pattern` skill.
- **Five standard endpoints**: `POST /` (create), `GET /` (findPaginated), `GET /:id` (findById), `PATCH /:id`, `DELETE /:id` (204). **Read-handler names are fixed — `findPaginated` and `findById`, never `findOne`/`findAll`.** `findById` says what it looks up by, which is why a controller stays single-resource: two `findById` can't coexist in one class, so a controller that would serve two resources gets split per resource rather than disambiguated into `find<Resource>ById`. **No unpaginated `GET /all`** — full-table reads OOM/crash the system at scale; always paginate via `GET /`. Lists use `MetaQueryDto` (`perPage` max 100); `findPaginated` builds its query via a private `buildListArgs` so sort/search stay centralized. Full pattern: `resource-pattern` skill.
- **Config access**: `configService.getOrThrow<T>('dot.path')` into `configuration.ts`. Never read `process.env` outside that file. `API_BASE_URL` = the API host (backend-handler links like verify-email); `WEB_BASE_URL` = the customer frontend (page links).
- **Swagger**: the compiler plugin infers DTOs (no manual `@ApiProperty` needed). `@ApiTags` + `@ApiBearerAuth()` on JWT routes. Paginated handlers MUST be decorated `@ApiPaginatedResponse(T)` (`common/decorators/`) — the plugin can't infer `T` through `PaginatedResponseDto<T>`'s generic. **Non-paginated handlers need an explicit `@ApiOkResponse`/`@ApiCreatedResponse({ type })`** — the plugin does NOT attach a response schema from the return type alone, so the body renders untyped in `/api/docs` without it. Side-effect / acknowledgement endpoints (password reset, resend, etc.) return a **shared typed DTO** (`OperationAcknowledgementDto { ok: boolean }`), never an inline object literal or inline `schema:`; a redirect handler is documented with `@ApiResponse({ status: 302 })`, not a fake 200. Extended mapped types (`PartialType`/`PickType`/`OmitType`/`IntersectionType`) import from `@nestjs/swagger`, not `@nestjs/mapped-types`, or inherited DTOs render empty. Sidebar is sorted A→Z (`tagsSorter`/`operationsSorter: 'alpha'` in `main.ts`). Swagger is gated off in production (`main.ts`).
- **Rate limiting**: global `ThrottlerGuard`, 100/60s/IP (Redis storage in dev/staging/prod, in-memory in test). Per-route `@Throttle({ default: { limit, ttl } })`; `@SkipThrottle()` for `/health/*`. Any `@Public()` or OTP/SMS/email-dispatching endpoint needs its own `@Throttle`.
- **Remote calls, queues, and retries**: every remote/blocking operation has an explicit timeout. Retry only known transient failures with a bounded attempt count, backoff, and jitter; retried writes must be idempotent. Queue consumers must tolerate duplicate delivery, preserve `correlationId`, and define terminal/poison-message handling. Never claim exactly-once behavior without a concrete mechanism.
- **Compatibility + rollout**: any request/response DTO, `errorCode`, enum, event payload, required field, database shape, or externally observable behavior change must identify its consumers, mixed-version behavior, deployment order, and rollback/roll-forward path. Type compatibility alone is not runtime compatibility; a cross-repo dependency remains a blocker until its owning change is shipped.
- **Logging**: pino (`nestjs-pino`) to **stdout/stderr only** — JSON in prod/staging, pretty in dev, never a file. `X-Request-Id` per request (reused or fresh UUID). Redacts `authorization`, `cookie`, `set-cookie`, and password/token/OTP body fields — extend `redact.paths` in `app.module.ts` for new sensitive bodies. Secrets in a **query string** are handled separately by the `req` serializer (`redactUrlSecrets`), because `redact.paths` censors whole properties and would erase the URL path with it; add any new secret-bearing query parameter there. A **queue worker** has no HTTP request, so `QueueProcessor` opens the CLS scope itself and seeds the request ID from the job payload's `correlationId` — a job's log lines carry the ID of the request that enqueued it.
- **Health indicators**: `/api/health/*` is `@Public()`, so a failing check **logs the real error and returns a fixed string** — never the driver's message (Prisma `P1001`/`P1000` quote the internal host and DB user; ioredis quotes host and port). CWE-209. Every indicator follows this and carries a co-located spec asserting the public payload leaks nothing; copy `prisma.health.ts` / `queue.health.ts` when adding one. Terminus reports a failure by serializing only what the indicator returns, so the explicit `logger.error` is what keeps an outage diagnosable — it is load-bearing, not decoration.
- **Provider abstractions** (`EmailService`, `SmsService`, `FileStorageService`, all `@Global()`): each has a `stub` default + a real adapter, selected by env (`EMAIL_PROVIDER`, `SMS_PROVIDER`, `STORAGE_PROVIDER` — `stub` | `s3` | `gcs` | `azure`). Only the selected adapter is constructed at boot, and for storage only the selected provider's SDK is even loaded. Call typed helpers (`emailService.sendTemplate(...)`, `smsService.sendPhoneVerificationOtp(...)`), not raw `.send(...)`. Email templates compile at boot — `{{var}}` typos fail startup.
- **File storage is provider-neutral**: four adapters (`stub` | `s3` | `gcs` | `azure`) behind one `FileStorageAdapter` interface, selected by `STORAGE_PROVIDER`. **A provider SDK may be imported ONLY by its own adapter file** — that boundary is what keeps this deployable to a different cloud without touching business logic. Adapters are `require`d lazily in `file-storage.module.ts`, so only the selected provider's SDK is loaded; do not convert those to static imports. **No adapter accepts a long-lived cloud credential and none is to be added** — each uses its platform's keyless identity chain, and a spec asserts no such key exists in the env schema.
- **Objects are private by default**: `resolvePublicUrl()` returns **null** unless `STORAGE_PUBLIC_URL_BASE` is set (an explicit operator assertion that the bucket is public). Reads use `createSignedReadUrl()`, clamped to [30s, 1h] — **authorize the caller first**, a signed URL is an unrevocable bearer credential. Store the **`storageKey`**, never a URL. Object names come from `buildObjectName` (`common/util/storage-object-name.util.ts`): a server-minted UUID plus a **code-chosen** subdirectory, never request input.
- **Redis connections**: every client — `RedisService`, the throttler storage, BullMQ — is built from `buildRedisConnectionOptions` (`common/redis/redis-connection.ts`). Never call `new Redis(url)` anywhere else. It returns **transport only** (host, credentials, logical database, TLS); each consumer adds its own behavioural options, because BullMQ requires `maxRetriesPerRequest: null` for its blocking commands and the app client deliberately does not. `REDIS_TLS_ENABLED` and the `REDIS_URL` scheme must agree or boot fails, and `rejectUnauthorized` is hard-coded `true`.
- **Postgres pool**: sized explicitly in `PrismaService` from `DATABASE_POOL_MAX` / `DATABASE_CONNECTION_TIMEOUT_MS` / `DATABASE_IDLE_TIMEOUT_MS`. The API autoscales, so the number that matters is `(API instances × poolMax) + (worker instances × poolMax) + the migration job < the database's connection limit`. Raising instance counts is a database-capacity change; the arithmetic is in `.env.example`.
- **Multipart uploads**: `imageUploadOptions` (`common/storage/image-upload.config.ts`) → `FilesInterceptor`; a structured body rides as a JSON-string field parsed by `ParseJsonPipe`. See `docs/resource-pattern.md`.
- **Layering**: `src/common/` is the leaf layer — `src/modules/` builds on it, **never the reverse**. ESLint enforces it (`no-restricted-imports` on `src/common/**`). Anything needing a service belongs in a module: that is why `PermissionsGuard` lives in `modules/authorization/guards/` while the decorators it reads stay in `common/decorators/` (pure metadata, zero dependencies).
- **Cross-module cycles**: use `forwardRef` in **both** the imports and the `@Inject`.

## TypeScript gotchas

- **Decorator + `isolatedModules`**: types in decorated signatures must use `import type` (or a separate type-only line) — value + type in one statement → TS1272. Same for `@Inject(TOKEN)` params: `TOKEN` is a value (regular import), its type is `import type`.
- **`@nestjs/jwt` `expiresIn`**: typed `number | StringValue`. Runtime `string` from ConfigService needs `as unknown as number` (see `auth.module.ts`).
- **Enum vs string column comparison**: DB columns are `String`; cast at the boundary first — `const existingStatus = existing.status as Status;` then compare (`no-unsafe-enum-comparison`).

## Lint / format

ESLint uses typescript-eslint **recommendedTypeChecked** (type-aware, slow on large diffs). Overrides: `no-explicit-any` off; `no-floating-promises` warn; `no-unsafe-argument` warn; Prettier as a rule with `endOfLine: "auto"`; `no-restricted-syntax` bans direct `new *Exception` construction outside `src/common/errors/` (use `Errors.*`). Recurring: cast enum-to-numeric (`(status as number) >= 500`); narrow supertest `res.body` (`const body = res.body as { ... }`).

## Prisma 7

Uses `@prisma/adapter-pg`. `schema.prisma` is `provider = "postgresql"` only (no `url`); `prisma.config.ts` loads `.env` with dotenv-expand and exposes `{ schema, migrations.path, datasource.url }`; `PrismaService` builds `PrismaPg({ connectionString })` and passes it to `super({ adapter })`. `pg` is a **runtime** dependency — bump adapter + `pg` together. **The template ships exactly ONE migration (`20260416151634_init`)** — a starter is a fork in time, so a clone begins its own migration history from whatever `init` says that day. Squash schema changes back into it rather than accreting edits nobody made. **Until any deployed env has applied migrations, edit migration files in place freely**; after the first real deploy they're checksummed in `_prisma_migrations`, so only add new migrations (use `--create-only` for raw-SQL constructs).

### Migrations while work is in progress (STRICT)
- **NEVER apply migrations on the local dev DB during in-progress work or planning.** Do **not** run `prisma:deploy` / `prisma migrate dev` / `prisma migrate reset` to "check" a schema change. `yarn build` (which runs `prisma generate` off `schema.prisma`) is enough to verify the code compiles against the new shape — no DB apply needed.
- **NEVER reset, drop, re-seed, or otherwise destroy local DB data on your own initiative** — not even "just local." The local dev DB holds the user's data; a reset is allowed **only** with the user's explicit permission (ask first) or on their direct instruction. If a migration must actually run to verify something, it runs against the **separate test DB** — the e2e harness owns it (`test/setup/global-setup.ts` drops/recreates the `.env.test` `DB_NAME` on every `test:e2e` run, never touching local). Test DB ≠ local DB — verify there.
- **Consolidate a multi-step schema change into ONE migration file** and apply it only when the whole batch is finalized — and even then, prefer to let the **user** apply it to their local/prod. Applying mid-flight locks the file's checksum, so folding in later changes means editing an already-applied migration (breaks `migrate deploy`).
- If a migration was applied to local by mistake, **surgically un-apply it** (inverse DDL + delete its `_prisma_migrations` row) preserving all rows — never `migrate reset`.

## Deep references

Load these on demand — they hold the long-form playbooks so this core stays lean. Methodology references resolve inside the `engineering-framework` plugin (`${CLAUDE_PLUGIN_ROOT}`); everything else is repository-owned.

| Task | Where |
|---|---|
| Drive a requirement end-to-end: map → plan → implement → review → validate → present | `/engineering-framework:work-item <key \| URL \| requirement>` |
| The five gates, run individually | `/engineering-framework:gate-design`, `gate-approve`, `gate-implement`, `gate-review`, `gate-validate` |
| Audit the framework/repository contract; check this file against reality | `/engineering-framework:framework-doctor` |
| General architecture, coding, security, testing, evidence rules | plugin `standards/` |
| Plan, threat-model, contract-change, data-design, validation-report formats | plugin `templates/` |
| Add/scaffold a CRUD resource (schema, five endpoints, list queries, response DTOs + relations, delete semantics, soft-delete filter) | `resource-pattern` skill (+ code skeletons in `docs/resource-pattern.md`) |
| Permissions, roles, business-scoped resources, `@RequirePermission`, CASL abilities, tenant isolation, escalation/rank guard, grants cache | `authorization` skill (+ the contract in `src/common/authorization/README.md`) |
| Auth / login / JWT / OTP / email-verify / phone-verify / lockout / timing hardening | `auth-security` skill |
| ALL background work — immediate / delayed / recurring, with retries, cancellation, rescheduling. BullMQ is the only mechanism; there is no in-process scheduler | `src/common/queue/README.md` |
| Write e2e specs (harness, coverage, cadence, error-envelope assertions) | `e2e-testing` skill |
| Error envelope contract + ErrorCode catalog + client logout rule | `src/common/errors/README.md` |
| Deployment: the provider-neutral runtime/container/database/Redis/storage/env contract | `docs/deployment/README.md` |
| Single-VM deployment (Caddy + per-env compose + GitHub Actions) | `docs/README.md` → `docs/prod/` + `docs/staging/` |
| Which operational controls are ACTUALLY enforced vs. only scaffolded — backups, restore verification, RPO/RTO, secret rotation, retention, backpressure, incident response, rollback | `docs/operations.md` |

**Settings and framework integration:**

- `.claude/settings.json` (committed) — the permissions floor. A plugin cannot ship permission rules, so this layer is **not** redundant with the plugin's guard hook: a hook is executable code and Claude Code treats a crashed hook as a *non-blocking* error, so it can fail open; a deny rule cannot. They are complementary, and **neither is a sandbox** — a shell can always express an operation the parser does not model. For a real boundary use OS sandboxing or a container.
  - This repository's floor is deliberately **larger** than the framework's: the framework ships **no MCP rules at all**, so the issue-tracker denies (`mcp__*__*transition*`, `*IssueField*`, `editJiraIssue`, …) exist only here. MCP rules use a **glob server segment** — a hardcoded `mcp__atlassian__…` matches nothing in a fork that named its server differently, so the tracker floor would silently vanish.
  - Every `Bash(...)` rule is mirrored as `PowerShell(...)`. The PowerShell tool is enabled by default on Windows without Git Bash and `Bash(...)` rules do not govern it, so an unmirrored rule disappears on those machines with no warning. **Add both forms, or neither.**
  - File rules are consulted for `Read()` and `Edit()` only. A `Write()`, `Glob()`, `MultiEdit()` or `NotebookEdit()` path rule is accepted, never consulted, and warns at startup — the worst failure shape available, because the file reads as protected.
  - **`allow` and `ask` rules use the `verb:*` prefix form; `deny` keeps `verb *`.** `Bash(yarn build *)` requires a space *and* an argument after `build`, so it never matches bare `yarn build` — an allow tier written that way prompts on every clean invocation, and an `ask` rule written that way lets the bare command fall through to a broader `allow`. The `deny` tier keeps `verb *` because the guard hook matches those operations in more forms than a prefix rule can express.
  - **Six rules from the framework's `allow` floor are deliberately absent, and re-adding them is a regression.** `docker compose down:*` (this repo *denies* teardown; the allow form would permit the bare command its own deny rule misses), `docker exec:*` (held at `ask`, with a `protectedCommands` entry for the `psql` shell), and `yarn|npm|pnpm|bun run:*` (`yarn run prisma:migrate` escapes the `yarn prisma:migrate *` deny — the floor leans on the guard hook there, and this file's whole premise is that a hook can fail open).
- `.claude/engineering-framework.json` (committed) — this repository's policy: canonical commands, `risk.highRiskPaths`, the `prisma/migrations/**` protected path, and the `protectedCommands` the framework's generic tables cannot know about (`docker compose down`, the fixing linter, `docker exec … psql`).
  - **One policy switch is deliberately relaxed:** `humanOwnedDependencyInstall: false`. Adding and removing packages is ordinary engineering here, and the lockfile is a protected path already, so the diff is visible at review. Migrations, deployments, Git writes, and pull requests all stay human-owned; publication, release, force pushes, and credential reads are denied regardless of this setting.
- `.claude/settings.local.json` (per-developer, gitignored) — personal allowlist and enabled MCP servers.
- `.claude/skills/` — four domain playbooks (`auth-security`, `authorization`, `e2e-testing`, `resource-pattern`), all `user-invocable: false`. The `/` menu belongs to the plugin; keep project skills out of it.
- `/engineering-framework:framework-doctor` — audits this repository against the framework contract. Replaces the former `yarn claude:validate` script.
