# CLAUDE.md

Guidance for Claude Code working in this repo. **This file is the always-on core** — it's loaded into context on every request, so it holds only what applies to *almost every* change. Situational, deep playbooks live in **skills** (`.claude/skills/`) and **docs** (`docs/`); load them when the task calls for them rather than duplicating their content here. See **Deep references** at the bottom.

## Engineering bar

You are **always** writing as a **senior software architect / senior software engineer** — every change, every file, every line, with no exceptions and without being asked. Code must be **standard, recommended, secure, and maintainable**. Never ship clutter, dead weight, copy-paste, or lazy shortcuts; if a change would lower the bar, stop and do it properly. Apply this default automatically:

- **Design for the proper end state, not the minimum change.** If 4 call sites share a pattern, migrate all 4. Don't leave the codebase half-migrated with a "TODO: do the rest later" — the rest is part of the work.
- **Name like a senior engineer — everywhere, including loops.** Variables, parameters, functions, methods, classes, and types all read as full, intention-revealing domain words. No single-letter or throwaway locals (`b`, `r`, `d`, `e`, `x`), no cryptic abbreviations (`errMsg`, `cfg`, `tmp`, `usr`, `req`, `res`), no vague placeholders (`data`, `item`, `obj`, `val`, `thing`), and **no `i`/`j` loop counters** — iterate with `for…of` / `.map`/`.entries()` over a named element, or name the index (`rowIndex`, `pageIndex`). Loop bodies and callbacks are **not** an exception — `for (const user of activeUsers)` and `.map((device) => …)`, never `for (const u of users)` / `.map((d) => …)`. Spell out Express handler params too: `request`/`response` (`next` is fine). The ONLY abbreviations allowed are repo-wide domain idioms already established here (`id`, `dto`, `url`, `db`, `ttl`, `jwt`, `otp`, `ip`) and single-letter generic type params (`T`, `K`). Ship this self-enforcing where practical (`id-length` + `id-denylist` ESLint rules), per "Make conventions self-enforcing" below.
  - **The exact same standard binds *declared* names — functions, methods, classes, types, enums, DTOs, files.** These are read far more often than locals, so a shortcut here is worse, not more acceptable. Spell the whole domain word: no truncated morphemes *anywhere* in an identifier — `Ack`→`Acknowledgement`, `Msg`→`Message`, `Mgr`→`Manager`, `Ctrl`→`Controller`, `Svc`→`Service`, `Repo`→`Repository`, `Calc`→`Calculate`, `Ctx`→`Context`, `Gen`→`Generate`, `Addr`→`Address`, `Num`→`Number`, `Val`→`Value`. So `OperationAcknowledgementDto`, never `OperationAckDto`; `formatServiceDateCompact`, never `fmtSvcDate`. A class/function/file name is API surface for every future reader — hold it to the *highest* bar, not the lowest.
- **Reach for established patterns over invention.** RFC standards, well-known API conventions (Stripe, Google Cloud), OWASP guidance, NestJS idioms — name the reference when justifying a choice.
- **Make conventions self-enforcing.** New conventions ship with a guardrail (ESLint rule, type contract, central factory, exhaustive switch, hook, etc.) so the next contributor can't drift. Documentation alone is not enough.
- **Single source of truth.** One filter, one envelope, one factory, one config file. Two files doing the same thing is a smell — consolidate.
- **Separate data, behavior, and pure helpers — no clutter.** Each file has one clear responsibility. A service/controller holds **behavior**, never large static lookup tables, registries, or config arrays dangling above the class — those move to a co-located config module (e.g. `*-registry.ts`) and are imported. Pure, reusable functions (string/date/enum/number transforms) live in `src/common/util/*.util.ts` with a `*.util.spec.ts`, never inline at the top of a service. Rule of thumb: if a reader must scroll past static data or a helper to reach the class, it's misfiled — extract it.
- **Security is non-negotiable.** Every endpoint and DTO needs a thought about attack surface (enumeration leaks, timing attacks, replay, FK escalation, role abuse, log redaction). See the `nestjs-auth-security` skill for the hardening floor.
- **Delete what you replace.** Old filters, old throws, old code paths — gone. No `// removed` comments, no `// legacy` directories, no parallel implementations.
- **Plans are ADRs.** Plan-mode output should read like an Architectural Decision Record: Context → Approach (with rationale + rejected alternatives) → File-by-file changes → Tests → Verification → What this deliberately does NOT do. Not a checklist.
- **"What do you think / what do you recommend" means PLAN, not execute.** When the user asks for your thoughts, opinion, or a recommendation, respond with senior-level planning — the analysis, the options with trade-offs, and your recommended approach — then **stop and wait**. Do NOT start editing files, writing migrations, or otherwise implementing. Implementation begins only when the user explicitly says to go ahead (e.g. "implement it", "do it", "go"). A plan or recommendation is never itself a green light.
- **Tests are part of the change.** A feature without e2e coverage on the contract isn't done. Update the existing assertions when the contract changes — don't add a duplicate test alongside the stale one.
- **Verify before declaring done.** `yarn build` + `yarn lint` + the **affected** e2e spec(s) must pass on every change; run the **full** `yarn test:e2e` only when a module is complete or the user asks. Type-check and a passing suite verify correctness, but don't claim a UI/feature works without actually exercising it.

When a small ask conflicts with this bar (e.g. "just fix this one site"), surface the conflict and propose the proper-scope plan first — don't silently scope down.

## Project

NestJS 11 (TypeScript, Express) + Prisma 7 + PostgreSQL + Redis. JWT auth with RBAC (`ADMIN`, `USER`). GitHub template: set `SERVICE_NAME` in `.env`, add feature modules. URLs unversioned (`/api/...`). Swagger at `/api/docs`.

Package manager: **yarn** (yarn.lock committed). Scripts: `start:dev`, `start:prod`, `build`, `lint`, `format`, `test`, `test:e2e`, `prisma:generate`, `prisma:migrate`, `prisma:deploy`, `prisma:seed`, `prisma:studio`. `docker compose up -d` brings up pinned Postgres 18.3 + Redis 8.6.2 (host ports **5433** / **6378**).

`SERVICE_NAME` is the single source of truth — drives `DB_NAME` default (`${SERVICE_NAME}_local`), container name, and JWT `iss`/`aud`.

## Architecture

```
src/
  main.ts              # bootstrap: helmet, prefix /api, trust proxy, CORS, Swagger (gated), shutdown hooks
  app.module.ts        # ConfigModule + ThrottlerModule + ScheduleModule + PrismaModule + features;
                       # APP_PIPE (ValidationPipe), APP_INTERCEPTOR (ClassSerializerInterceptor),
                       # APP_FILTER (GlobalExceptionFilter), APP_GUARD (ThrottlerGuard)
  config/              # configuration.ts (typed factory), env.validation.ts (Joi)
  prisma/              # @Global() PrismaModule + PrismaService + soft-delete extension
  common/
    decorators/        # Roles, CurrentUser (+ AuthenticatedUser), Public, IsUtcIsoString
    guards/            # RolesGuard (reads ROLES_KEY metadata)
    filters/           # GlobalExceptionFilter (single unified filter)
    errors/            # ErrorCode enum, Errors factory, app-exception types, README (the error contract)
    pipes/             # ParseJsonPipe (multipart JSON-string body field)
    dto/               # MetaQueryDto (page/perPage/search/sortBy/sortOrder + buildOrderBy), PaginatedResponseDto<T>
    enums/             # Role, Gender, OtpPurpose, AppPlatform, DeviceType, DeviceOs
    email/  sms/  storage/   # @Global() provider abstractions (stub + real adapters)
    audit/  redis/  scheduled-jobs/
  modules/
    auth/ users/ app-versions/ device-tokens/ health/ public/
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
- **No DB enums**: enum-like columns are `String`; constrain via TS enum in `src/common/enums/` + `@IsEnum()`. UPPER_SNAKE keys, lowercase_snake values; cast at the DB→app boundary (`user.role as Role`). Changing a TS enum needs no migration.
- **Boolean columns are `is`-prefixed**: every `Boolean` DB column (and its DTO field) reads as a predicate — `isActive`, `isFeatured`, `isEnabled`, `isVerified` — never bare nouns/verbs (`enabled`, `verified`, `active`). Keeps the schema self-describing and greppable.
- **RBAC**: `@UseGuards(JwtAuthGuard, RolesGuard)` at class, `@Roles(Role.ADMIN)` on handlers (omit for any authenticated user — `RolesGuard` is a no-op without `@Roles()`). `@Public()` for public handlers. `@CurrentUser()` returns `AuthenticatedUser`, NOT a full `User`. JWT carries `{ sub, email, role }`; `JwtStrategy.validate` re-fetches via `findByIdOrNull` (non-throwing → 401 not 404) and checks `isActive`.
- **Audit fields**: `createdBy`/`updatedBy` do **not** auto-populate. Every mutating service method takes `actorId: string | null` and writes it; controllers pass `@CurrentUser().id` (or `null` for unauthenticated creates).
- **Audit log + request envelope**: record privileged/security actions via `AuditService.record({ action, actorId, targetUserId, metadata })` — best-effort (a failed write never blocks the operation). Inside an HTTP request a server-vouched `metadata.request` envelope (requestId/ip/userAgent/method/path + parsed browser·os·device + Cloudflare country·ray) is auto-merged by the `ClsModule` middleware (`app.module.ts`); cron/script calls (no request context) skip it cleanly. Don't pass a caller `metadata.request` key — it's overwritten. The `requestId` matches the pino `X-Request-Id` for the same request.
- **Disposable-email blocking**: `isDisposableEmail()` (`common/util/disposable-email.util.ts`, backed by `disposable-email-domains`) gates auth — register **silently drops** (byte-identical 201/body, no user row, audited), login collapses to `INVALID_CREDENTIALS` behind a timing-safe dummy bcrypt (audited). Never surface the block to the caller (no enumeration). `Errors.emailDomainDisallowed(domain)` exists for non-auth contexts where surfacing the reason is acceptable.
- **Prisma access**: through `PrismaService` (`@Global()`). `prisma.scoped.*` auto-injects `deletedAt: null` for soft-delete models (every user-facing read); raw `prisma.*` sees soft-deleted (admin/forensic/recovery). Adding a soft-delete model + the full mechanism: `nestjs-new-resource` skill.
- **Five standard endpoints**: `POST /` (create), `GET /` (findPaginated), `GET /:id`, `PATCH /:id`, `DELETE /:id` (204). **No unpaginated `GET /all`** — full-table reads OOM/crash the system at scale; always paginate via `GET /`. Lists use `MetaQueryDto` (`perPage` max 100); `findPaginated` builds its query via a private `buildListArgs` so sort/search stay centralized. Full pattern: `nestjs-new-resource` skill.
- **Config access**: `configService.getOrThrow<T>('dot.path')` into `configuration.ts`. Never read `process.env` outside that file. `API_BASE_URL` = the API host (backend-handler links like verify-email); `WEB_BASE_URL` = the customer frontend (page links).
- **Swagger**: the compiler plugin infers DTOs (no manual `@ApiProperty` needed). `@ApiTags` + `@ApiBearerAuth()` on JWT routes. Paginated handlers MUST be decorated `@ApiPaginatedResponse(T)` (`common/decorators/`) — the plugin can't infer `T` through `PaginatedResponseDto<T>`'s generic. **Non-paginated handlers need an explicit `@ApiOkResponse`/`@ApiCreatedResponse({ type })`** — the plugin does NOT attach a response schema from the return type alone, so the body renders untyped in `/api/docs` without it. Side-effect / acknowledgement endpoints (password reset, resend, etc.) return a **shared typed DTO** (`OperationAcknowledgementDto { ok: boolean }`), never an inline object literal or inline `schema:`; a redirect handler is documented with `@ApiResponse({ status: 302 })`, not a fake 200. Extended mapped types (`PartialType`/`PickType`/`OmitType`/`IntersectionType`) import from `@nestjs/swagger`, not `@nestjs/mapped-types`, or inherited DTOs render empty. Sidebar is sorted A→Z (`tagsSorter`/`operationsSorter: 'alpha'` in `main.ts`). Swagger is gated off in production (`main.ts`).
- **Rate limiting**: global `ThrottlerGuard`, 100/60s/IP (Redis storage in dev/staging/prod, in-memory in test). Per-route `@Throttle({ default: { limit, ttl } })`; `@SkipThrottle()` for `/health/*`. Any `@Public()` or OTP/SMS/email-dispatching endpoint needs its own `@Throttle`.
- **Logging**: pino (`nestjs-pino`), JSON in prod/staging, pretty in dev. `X-Request-Id` per request (reused or fresh UUID). Redacts `authorization`, `cookie`, password/OTP body fields — extend `redact.paths` in `app.module.ts` for new sensitive bodies.
- **Provider abstractions** (`EmailService`, `SmsService`, `FileStorageService`, all `@Global()`): each has a `stub` default + a real adapter, selected by env (`EMAIL_PROVIDER`, `SMS_PROVIDER`, `STORAGE_PROVIDER`). Only the selected adapter is constructed at boot. Call typed helpers (`emailService.sendTemplate(...)`, `smsService.sendPhoneVerificationOtp(...)`), not raw `.send(...)`. Email templates compile at boot — `{{var}}` typos fail startup.
- **Multipart uploads**: `imageUploadOptions` (`common/storage/image-upload.config.ts`) → `FilesInterceptor`; a structured body rides as a JSON-string field parsed by `ParseJsonPipe`. See `docs/resource-pattern.md`.
- **Cross-module cycles**: use `forwardRef` in **both** the imports and the `@Inject`.

## TypeScript gotchas

- **Decorator + `isolatedModules`**: types in decorated signatures must use `import type` (or a separate type-only line) — value + type in one statement → TS1272. Same for `@Inject(TOKEN)` params: `TOKEN` is a value (regular import), its type is `import type`.
- **`@nestjs/jwt` `expiresIn`**: typed `number | StringValue`. Runtime `string` from ConfigService needs `as unknown as number` (see `auth.module.ts`).
- **Enum vs string column comparison**: DB columns are `String`; cast at the boundary first — `const existingStatus = existing.status as Status;` then compare (`no-unsafe-enum-comparison`).

## Lint / format

ESLint uses typescript-eslint **recommendedTypeChecked** (type-aware, slow on large diffs). Overrides: `no-explicit-any` off; `no-floating-promises` warn; `no-unsafe-argument` warn; Prettier as a rule with `endOfLine: "auto"`; `no-restricted-syntax` bans direct `new *Exception` construction outside `src/common/errors/` (use `Errors.*`). Recurring: cast enum-to-numeric (`(status as number) >= 500`); narrow supertest `res.body` (`const body = res.body as { ... }`).

## Prisma 7

Uses `@prisma/adapter-pg`. `schema.prisma` is `provider = "postgresql"` only (no `url`); `prisma.config.ts` loads `.env` with dotenv-expand and exposes `{ schema, migrations.path, datasource.url }`; `PrismaService` builds `PrismaPg({ connectionString })` and passes it to `super({ adapter })`. `pg` is a **runtime** dependency — bump adapter + `pg` together. **Until any deployed env has applied migrations, edit migration files in place freely**; after the first real deploy they're checksummed in `_prisma_migrations`, so only add new migrations (use `--create-only` for raw-SQL constructs).

### Migrations while work is in progress (STRICT)
- **NEVER apply migrations on the local dev DB during in-progress work or planning.** Do **not** run `prisma:deploy` / `prisma migrate dev` / `prisma migrate reset` to "check" a schema change. `yarn build` (which runs `prisma generate` off `schema.prisma`) is enough to verify the code compiles against the new shape — no DB apply needed.
- **NEVER reset, drop, re-seed, or otherwise destroy local DB data on your own initiative** — not even "just local." The local dev DB holds the user's data; a reset is allowed **only** with the user's explicit permission (ask first) or on their direct instruction. If a migration must actually run to verify something, it runs against the **separate test DB** — the e2e harness owns it (`test/setup/global-setup.ts` drops/recreates the `.env.test` `DB_NAME` on every `test:e2e` run, never touching local). Test DB ≠ local DB — verify there.
- **Consolidate a multi-step schema change into ONE migration file** and apply it only when the whole batch is finalized — and even then, prefer to let the **user** apply it to their local/prod. Applying mid-flight locks the file's checksum, so folding in later changes means editing an already-applied migration (breaks `migrate deploy`).
- If a migration was applied to local by mistake, **surgically un-apply it** (inverse DDL + delete its `_prisma_migrations` row) preserving all rows — never `migrate reset`.

## Deep references

Load these on demand — they hold the long-form playbooks so this core stays lean:

| Task | Where |
|---|---|
| Add/scaffold a CRUD resource (schema, six endpoints, list queries, response DTOs + relations, delete semantics, soft-delete filter) | `nestjs-new-resource` skill (+ code skeletons in `docs/resource-pattern.md`) |
| Auth / login / JWT / OTP / email-verify / phone-verify / lockout / timing hardening / security review | `nestjs-auth-security` skill |
| Scheduled `@Cron` job | `nestjs-scheduled-job` skill |
| Write e2e specs (harness, coverage, cadence, error-envelope assertions) | `nestjs-e2e-test` skill |
| Error envelope contract + ErrorCode catalog + client logout rule | `src/common/errors/README.md` |
| Deployment / infra (Caddy + per-env compose + GitHub Actions) | `docs/README.md` → `docs/prod/` + `docs/staging/` |
