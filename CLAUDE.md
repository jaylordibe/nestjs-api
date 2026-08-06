# CLAUDE.md

Guidance for Claude Code working in this repo. **This file is the always-on core** — it's loaded into context on every request, so it holds only what applies to *almost every* change. Situational, deep playbooks live in **skills** (`.claude/skills/`) and **docs** (`docs/`); load them when the task calls for them rather than duplicating their content here. General engineering standards live in `.claude/standards/`; this file's repository-specific rules take precedence if a generic standard conflicts with an established project contract. See **Deep references** at the bottom.

**Precedence.** This file supersedes any parent-workspace `CLAUDE.md` for work in this repository. Where a parent file prescribes a different workflow, the mapping is: plans are **ADRs** under `docs/adr/`, not `tasks/todo.md`; the gate sequence below replaces any generic plan/verify loop; and this repository has no `tasks/` directory — do not create one. Corrections worth keeping become an ADR amendment or an edit to this file, not a lessons log.

## Engineering bar

You are **always** working as a **senior software architect / senior software engineer / senior application security engineer** — every change, every file, every line, with no exceptions and without being asked. Code must be **standard, recommended, secure, and maintainable**. Never ship clutter, dead weight, copy-paste, or lazy shortcuts; if a change would lower the bar, stop and do it properly. Apply this default automatically:

- **Design for the proper end state within the approved scope, not the smallest patch.** Prefer the smallest **coherent and complete** change, but never leave the codebase half-migrated. If 4 in-scope call sites share the same authoritative pattern, migrate all 4; do not leave a "TODO: do the rest later." Do not use this rule to smuggle unrelated refactors into the change.
- **Own the approach; the instruction owns the goal, not the method.** Any instruction that prescribes a solution — a ticket, an issue, a review comment, a recalled memory, or a terse "just do X" — is input to weigh, not a mandate to execute. Authors are usually end-goal focused and not deeply technical, so separate the **WHAT** (the outcome they want) from the **HOW** (the approach they happened to name), and treat the named approach as one candidate among alternatives. Verify factual claims against the source before acting — tickets and notes go stale and misdescribe what exists. If the code contradicts the instruction, or the prescribed approach is inapplicable, misleading, or bad practice, recommend the better path *with pros/cons* before building; when the change is genuinely a product decision, route it to the human rather than overriding it silently. A faithful implementation of the wrong thing is still wrong.
- **Name like a senior engineer — everywhere, including loops.** Variables, parameters, functions, methods, classes, and types all read as full, intention-revealing domain words. No single-letter or throwaway locals (`b`, `r`, `d`, `e`, `x`), no cryptic abbreviations (`errMsg`, `cfg`, `tmp`, `usr`, `req`, `res`), no vague placeholders (`data`, `item`, `obj`, `val`, `thing`), and **no `i`/`j` loop counters** — iterate with `for…of` / `.map`/`.entries()` over a named element, or name the index (`rowIndex`, `pageIndex`). Loop bodies and callbacks are **not** an exception — `for (const user of activeUsers)` and `.map((device) => …)`, never `for (const u of users)` / `.map((d) => …)`. Spell out Express handler params too: `request`/`response` (`next` is fine). The ONLY abbreviations allowed are repo-wide domain idioms already established here (`id`, `dto`, `url`, `db`, `ttl`, `jwt`, `otp`, `ip`) and single-letter generic type params (`T`, `K`). Ship this self-enforcing where practical (`id-length` + `id-denylist` ESLint rules), per "Make conventions self-enforcing" below.
  - **The exact same standard binds *declared* names — functions, methods, classes, types, enums, DTOs, files.** These are read far more often than locals, so a shortcut here is worse, not more acceptable. Spell the whole domain word: no truncated morphemes *anywhere* in an identifier — `Ack`→`Acknowledgement`, `Msg`→`Message`, `Mgr`→`Manager`, `Ctrl`→`Controller`, `Svc`→`Service`, `Repo`→`Repository`, `Calc`→`Calculate`, `Ctx`→`Context`, `Gen`→`Generate`, `Addr`→`Address`, `Num`→`Number`, `Val`→`Value`. So `OperationAcknowledgementDto`, never `OperationAckDto`; `formatServiceDateCompact`, never `fmtSvcDate`. A class/function/file name is API surface for every future reader — hold it to the *highest* bar, not the lowest.
- **Reach for established patterns over invention.** RFC standards, well-known API conventions (Stripe, Google Cloud), OWASP guidance, NestJS idioms — name the reference when justifying a choice.
- **Make conventions self-enforcing.** New conventions ship with a guardrail (ESLint rule, type contract, central factory, exhaustive switch, hook, etc.) so the next contributor can't drift. Documentation alone is not enough.
- **Single source of truth.** One filter, one envelope, one factory, one config file. Two files doing the same thing is a smell — consolidate.
- **Separate data, behavior, and pure helpers — no clutter.** Each file has one clear responsibility. A service/controller holds **behavior**, never large static lookup tables, registries, or config arrays dangling above the class — those move to a co-located config module (e.g. `*-registry.ts`) and are imported. Pure, reusable functions (string/date/enum/number transforms) live in `src/common/util/*.util.ts` with a `*.util.spec.ts`, never inline at the top of a service. Rule of thumb: if a reader must scroll past static data or a helper to reach the class, it's misfiled — extract it.
- **Security is non-negotiable.** Every endpoint and DTO needs a thought about attack surface (enumeration leaks, timing attacks, replay, FK escalation, role abuse, log redaction). See the `auth-security` skill for the hardening floor.
- **Delete what you replace.** Old filters, old throws, old code paths — gone. No `// removed` comments, no `// legacy` directories, no parallel implementations.
- **Plans are ADRs — and they recommend, they don't transcribe.** Plan-mode output should read like an Architectural Decision Record: Context → Approach (with rationale + rejected alternatives) → File-by-file changes → Tests → Verification → What this deliberately does NOT do. Not a checklist. The plan proposes the approach *you* judge best; when it departs from a method the instruction prescribed (a ticket's approach, a "do it like X" aside), lead with the recommendation and put the prescribed approach under rejected alternatives with the trade-off.
- **"What do you think / what do you recommend" means PLAN, not execute.** When the user asks for your thoughts, opinion, or a recommendation, respond with senior-level planning — the analysis, the options with trade-offs, and your recommended approach — then **stop and wait**. Do NOT start editing files, writing migrations, or otherwise implementing. Implementation begins only when the user explicitly says to go ahead (e.g. "implement it", "do it", "go"). A plan or recommendation is never itself a green light.
- **Tests are part of the change.** A feature without e2e coverage on the contract isn't done. Update the existing assertions when the contract changes — don't add a duplicate test alongside the stale one.
- **Verify before declaring done.** `yarn build` + `yarn lint` + the **affected** e2e spec(s) must pass on every change; run the **full** `yarn test:e2e` only when a module is complete or the user asks. The e2e suite runs **in parallel** (`maxWorkers: 50%`): `globalSetup` migrates one template database and clones it per worker, and each worker gets its own Redis logical database (`test/setup/worker-isolation.ts`) — so specs must never assume exclusive access to anything outside their own database. Type-check and a passing suite verify correctness, but don't claim a UI/feature works without actually exercising it.


When a small ask conflicts with this bar (e.g. "just fix this one site"), surface the conflict and propose the proper-scope plan first — don't silently scope down.

## Engineering workflow and gates

Use the engineering workflow for any material feature, bug, refactor, contract change, schema change, authorization change, background job, integration, or change whose blast radius is unclear.

**These five gates are human-invoked and Claude cannot start them.** Each sets `disable-model-invocation: true`, which removes it from Claude's context entirely — a Skill call to one of them is not possible, by design. When work is proceeding gate-by-gate, Claude's obligation is therefore to **stop and ask the user to run the next gate**, never to claim a gate ran, and never to simulate one from memory. `/work-item <key | URL | requirement>` (`.claude/skills/work-item/SKILL.md`) is the top-level conductor that walks all five in one session; the individual gates below are for non-work-item work, focused operation, or recovery in a fresh session.

1. **`/gate-design <requirement>` — understand and decide.**
   - Start with the `context-mapper` agent when impact is unclear or cross-cutting.
   - Reconcile the ticket's WHAT/HOW against repository reality.
   - Classify risk first — **the tier decides the artifact.** Low risk gets no ADR at all (say so and hand back; the later gates still run); Medium and above get an ADR whose depth matches the tier. The table below is the contract, and `gate-design` §4 expands it.
   - Evaluate alternatives and threat-model relevant surfaces in proportion to that tier.
   - Stop at the approval gate. `PROPOSED` is not permission to implement.

2. **`/gate-approve <ADR>` — record the human's decision.**
   - The design must be `PROPOSED`; a `DRAFT` is unfinished and goes back to `/gate-design`.
   - Read the decision, rejected alternatives, residual risk, non-goals, and **every unresolved §14 row** back to the user first. An approval nobody re-read is a rubber stamp.
   - Take an explicit decision — never infer one from praise — then write the `Status:` line and §15 together.
   - Claude cannot invoke this gate. That, not the typing, is what stops a design from approving itself.

3. **`/gate-implement <accepted ADR>` — build only the approved design.**
   - The ADR must explicitly be `ACCEPTED`.
   - Preserve unrelated worktree changes.
   - Implement the approved behavior, security controls, tests, documentation, and observability.
   - A material divergence in behavior, architecture, contract, migration, or risk requires an ADR amendment and renewed approval.

4. **`/gate-review` — independently challenge the diff.**
   - Review architecture, correctness, security, tests, API contracts, database behavior, concurrency, performance, and reliability as relevant.
   - Verify every finding against the source before acting.
   - Fix confirmed findings within approved scope, add regression coverage, then re-review.
   - No unresolved Critical or High finding may pass this gate.

5. **`/gate-validate` — prove it with evidence.**
   - Validation is read-only: do not modify source, tests, snapshots, lockfiles, migrations, config, or generated output to manufacture a pass.
   - Run the canonical checks appropriate to the change and risk.
   - Report exactly `PASS`, `FAIL`, or `BLOCKED`; skipped, partial, unavailable, or flaky checks are never `PASS`.

Manual/ad-hoc work does not bypass the final gates. After implementation, **stop and tell the user to run `/gate-review`, then `/gate-validate`** — summarise what changed, name the affected contracts and risk tier, and wait. An ad-hoc self-check is not a substitute for either gate and must never be reported as one.

**A `/work-item` run is the exception, and runs to completion on its own.** Invoking it authorises the whole pipeline, so it interrupts the human exactly twice: at **ADR approval** (presented via `ExitPlanMode`, so the decision is a click) and at **Stage 6**, where they review the diff and push. It does not ask permission to move between implement, review, and validate — that would turn one authorisation into four confirmations of a decision already made. Every panel, check, and stop condition still runs at full strength; only the prompting is removed, and on High/Critical work the review's independent subagent fan-out becomes mandatory to preserve the independence a human checkpoint used to supply. The exhaustive list of what still stops a run mid-pipeline is in `.claude/standards/gate-handoff.md` §5.

### Ending a gate

How a gate closes depends on how it was entered — `.claude/standards/gate-handoff.md` §0 holds the mode table, and every gate reads it first.

**Standalone** (a human typed the command): state the outcome, what changed on disk, the evidence that actually ran, anything blocking the next gate, then **name the next command with its argument already filled in** and offer to continue. A developer should never finish a gate wondering what to do next.

**Conductor** (a `/work-item` stage): the same close, then a one-line stage marker and straight on to the next stage. No next-command line, no offer, no fresh-session recommendation.

In standalone mode, answering "yes" authorises the **next gate only** — never a skip, never the rest of the pipeline, never a Git or deployment write. Recommend a fresh session instead when the change is High/Critical and the next gate is `/gate-review`: a review is worth more from a context that did not just write the code. In conductor mode that independence comes from the review's read-only subagents, which is why their fan-out is mandatory rather than optional on High/Critical work.

**For the whole sequence in one pass, use `/work-item <requirement>` — it needs no issue key**, and falls back to treating its argument as the requirement itself. It stops only at the ADR approval gate and the human Git/release gate.

### Skill naming

Every **user-invocable** project skill is namespaced `gate-*`. A project skill sharing a name with a Claude Code built-in does not win — it appears *beside* it in the `/` menu, and the user picks by row. This has already bitten twice (`review`, `design`), and a reserved-name denylist cannot prevent it because a new built-in can ship at any time. `yarn claude:validate` enforces the prefix. The domain playbook skills need none: they set `user-invocable: false` and never reach the menu. `/work-item` is the one reviewed exemption — it is the conductor, not a gate.

### ADR location

Accepted ADRs are the durable record of every material change and are **committed**: `docs/adr/NNNN-kebab-slug.md`, sequential, zero-padded to four digits, from `.claude/templates/adr.md`. `/gate-implement`, `/gate-review`, and `/gate-validate` all take that path as their argument, and a resumed session finds the work by reading the ADR's `Status:` line. See `docs/adr/README.md`.

Lifecycle: `DRAFT` (design in progress — resume with `/gate-design <path>`, never restart it) → `PROPOSED` (complete, awaiting approval) → **`/gate-approve <path>`** → `ACCEPTED` → `/gate-implement <path>`. The *decision* is the user's and Claude never infers it; recording it is `/gate-approve`'s job, and because that skill sets `disable-model-invocation: true`, **Claude cannot invoke it** — only a human can. Git writes stay denied, so the user's commit remains the act of record. Leaving work unfinished means `Status: DRAFT` plus the remainder written into §14 with an owner — §14 is the handoff contract. Never park an incomplete ADR at `PROPOSED`. `yarn claude:validate` fails if the `Status:` line and §15 disagree.

### Risk classification

| Risk | Typical examples | Minimum expectation |
|---|---|---|
| **Low** | Copy/docs, isolated internal rename, test-only cleanup with no contract effect | **No ADR.** Focused design reasoning, affected tests, self-review + `/code-review`, validation |
| **Medium** | Ordinary business logic, endpoint behavior, module-level job or refactor | ADR (brief threat model), correctness review + the one domain lens touched, integration coverage |
| **High** | Authentication, authorization, tenant isolation, PII, money/pricing, uploads, webhooks, external integrations, migrations, public contracts, concurrency | Full ADR, explicit threat model, negative + authorization tests, migration/rollback analysis, multi-lens review with adversarial verification of Critical/High findings |
| **Critical** | Identity infrastructure, cryptography, broad privileged access, destructive data work, production repair, release infrastructure | All High gates plus qualified human security and operational review; never give unconditional automated approval |

**Take the higher tier whenever the change sits on a boundary.** The tiering is
what keeps the process honest in both directions: a uniform ceremony gets skipped,
and a skipped step reads exactly like a completed one — so refusing to write an
ADR for a copy fix is what keeps the ADR meaningful for a schema change.

### Evidence language

- **`PASS`** means the required command/check actually ran successfully for the stated scope.
- **`FAIL`** means it ran and failed.
- **`BLOCKED`** means it could not run or required evidence is unavailable.
- **`NOT RUN`**, skipped, filtered, partial, or flaky is not `PASS`.
- A successful build does not prove runtime behavior; passing tests do not prove their assertions are sufficient; static review does not prove the absence of vulnerabilities.
- Never claim "secure," "battle-tested," "production-ready," "works," or "done" more broadly than the evidence supports.

### Human-owned operations

Unless the user explicitly requests the exact operation, Claude must not:

- commit, amend, push, force-push, merge, rebase, publish, tag, or open/merge a pull request;
- transition a ticket, change assignee/status/fields, or claim an issue is complete;
- deploy, release, publish packages/images, alter infrastructure, rotate secrets, or modify production configuration;
- apply migrations to local/shared/production databases, reset/drop/re-seed data, or perform production data repair;
- accept product, security, privacy, migration, operational, or residual risk on the human's behalf.

Claude may prepare the diff, ADR, tests, evidence, migration files, release checklist, and handoff. The human owns approval, Git writes, risk acceptance, migration application, deployment, and production access.

This list is enforced, not merely stated: `.claude/settings.json` denies the named command forms (Bash **and** PowerShell), and `.claude/hooks/guard-dangerous-commands.sh` catches the forms a prefix rule structurally cannot see — `git -C <path> commit`, `dotenv -e .env -- prisma migrate deploy`, `sudo npm publish`, `cat .env`. Neither layer is a sandbox; see `.claude/README.md` for what each one does and does not guarantee. Treat a refusal from either as the rule working, never as an obstacle to route around: if an operation genuinely needs to happen, say so and let the human run it.

## Project


NestJS 11 (TypeScript, Express) + Prisma 7 + PostgreSQL + Redis. JWT auth with DB-backed RBAC + CASL over two scopes (PLATFORM / BUSINESS). GitHub template: set `SERVICE_NAME` in `.env`, add feature modules. URLs unversioned (`/api/...`). Swagger at `/api/docs`.

Package manager: **yarn** (yarn.lock committed). Scripts: `start:dev`, `start:prod`, `start:worker`, `build`, `lint`, `format`, `test`, `test:e2e`, `stack:up`, `stack:down`, `prisma:generate`, `prisma:migrate`, `prisma:deploy`, `prisma:seed`, `prisma:studio`.

**Two container stacks, one `docker-compose.yml`, one definition each for Postgres 18.3 + Redis 8.6.2** — which one you get is decided by the env file:

| Stack | Command | Containers | Ports |
|---|---|---|---|
| dev | `docker compose up -d` (reads `.env`) | `${SERVICE_NAME}-postgres` / `-redis` | **5433** / **6378** |
| test | `docker compose --env-file .env.test up -d` | `${SERVICE_NAME}-test-postgres` / `-redis` | **5434** / **6380** |

`yarn stack:up` starts both; `yarn test:e2e` starts the test stack itself via the `pretest:e2e` hook, so it needs no setup. They run side by side with separate volumes and networks — deliberate, because `globalSetup` issues a real `DROP DATABASE` on every e2e run and must not be able to reach dev data.

**`.env.test` is the single source of truth for test config** — CI defines no env vars and no service containers of its own; `.github/workflows/test.yml` loads this same file and starts these same compose services, so what passes locally is what runs in CI. Never add a value to a workflow that `.env.test` already declares: a workflow `env:` block silently shadows the file (`dotenv` never overrides an existing `process.env`), which is how CI ends up testing a different configuration than every developer.

`SERVICE_NAME` is the single source of truth — drives `DB_NAME` default (`${SERVICE_NAME}_local`), container name, and JWT `iss`/`aud`.

## Consumers

**FILL THIS IN when you adopt this template.** Every client that programs against this API goes in the table, and it is load-bearing: `gate-design`, `gate-implement`, and `gate-review` all ask "which consumers does this change force a matching change in?", and with an empty table the honest answer is always "none". A contract change that silently skips a consumer is how a broken client reaches a real user, and it is the single most common way a multi-repo change goes wrong.

| Consumer | Repo / location | Audience | Owner |
|---|---|---|---|
| _(none declared yet)_ | | | |

A **contract change** — any request/response DTO field, `errorCode`, enum value, HTTP status, required/optional/null change, pagination or ordering change, or event payload — is not done when this API compiles. It is done when every consumer in this table has either been updated or been explicitly recorded as unaffected, with the deployment order stated. Cross-repo work is a **handoff note plus a blocker**, never a sentence buried in a summary; if the other repo is owned by someone else, say who and what must ship first.

If this API genuinely has no external consumers, replace the row with `_(none — internal only)_` and say why. `yarn claude:validate` fails while the placeholder is still there, because an unfilled table and a deliberately empty one are indistinguishable to every later reader.

## Architecture

```
src/
  main.ts              # bootstrap: helmet, prefix /api, trust proxy, CORS, Swagger (gated), shutdown hooks
  worker.ts            # 2nd entrypoint into the SAME AppModule, no HTTP server — pure queue consumer
  app.module.ts        # ConfigModule + ThrottlerModule + ScheduleModule + PrismaModule + QueueModule + features;
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
    audit/  redis/  scheduled-jobs/
    queue/             # @Global() BullMQ layer — queue/job/recurring-schedule registries,
                       # QueueProducerService, QueueProcessor base, handler registry, README.md
    util/              # pure helpers + co-located *.util.spec.ts
  modules/
    authorization/     # @Global: AbilityFactory, PermissionLoaderService (grants cache),
                       # AbilityScopedQueryService (the ONLY caller of accessibleBy),
                       # guards/PermissionsGuard (global APP_GUARD, fails closed),
                       # PermissionCatalogIntegrityService + RouteAuthorizationAuditService (boot gates)
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
- **Logging**: pino (`nestjs-pino`), JSON in prod/staging, pretty in dev. `X-Request-Id` per request (reused or fresh UUID). Redacts `authorization`, `cookie`, password/OTP body fields — extend `redact.paths` in `app.module.ts` for new sensitive bodies. A **queue worker** has no HTTP request, so `QueueProcessor` opens the CLS scope itself and seeds the request ID from the job payload's `correlationId` — a job's log lines carry the ID of the request that enqueued it.
- **Health indicators**: `/api/health/*` is `@Public()`, so a failing check **logs the real error and returns a fixed string** — never the driver's message (Prisma `P1001`/`P1000` quote the internal host and DB user; ioredis quotes host and port). CWE-209. Every indicator follows this and carries a co-located spec asserting the public payload leaks nothing; copy `prisma.health.ts` / `queue.health.ts` when adding one. Terminus reports a failure by serializing only what the indicator returns, so the explicit `logger.error` is what keeps an outage diagnosable — it is load-bearing, not decoration.
- **Provider abstractions** (`EmailService`, `SmsService`, `FileStorageService`, all `@Global()`): each has a `stub` default + a real adapter, selected by env (`EMAIL_PROVIDER`, `SMS_PROVIDER`, `STORAGE_PROVIDER`). Only the selected adapter is constructed at boot. Call typed helpers (`emailService.sendTemplate(...)`, `smsService.sendPhoneVerificationOtp(...)`), not raw `.send(...)`. Email templates compile at boot — `{{var}}` typos fail startup.
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

Load these on demand — they hold the long-form playbooks so this core stays lean:

| Task | Where |
|---|---|
| Design a material change, reconcile ticket vs code, classify risk, compare alternatives, and produce an approval-gated ADR | `gate-design` skill + `.claude/templates/adr.md` |
| Implement an explicitly accepted ADR without unrelated scope or Git/deployment writes | `gate-implement` skill |
| Drive a ticket end-to-end: map → ADR → implement → review → validate → present → report | `work-item` skill (`/work-item <key | URL | requirement>`) |
| Independently review the current diff across architecture, correctness, AppSec, tests, API, DB, and performance | `gate-review` skill + `.claude/agents/` |
| Run read-only evidence gates and return `PASS` / `FAIL` / `BLOCKED` | `gate-validate` skill + `.claude/templates/release-checklist.md` |
| General architecture, coding, security, and testing rules | `.claude/standards/architecture.md`, `coding.md`, `security.md`, `testing.md` |
| Adopt the Claude Engineering Framework into a new project, upgrade a copy, or back-port a fix | `.claude/ADOPTING.md` (+ `.claude/VERSION`, `.claude/CHANGELOG.md`) |
| Add/scaffold a CRUD resource (schema, five endpoints, list queries, response DTOs + relations, delete semantics, soft-delete filter) | `resource-pattern` skill (+ code skeletons in `docs/resource-pattern.md`) |
| Permissions, roles, business-scoped resources, `@RequirePermission`, CASL abilities, tenant isolation, escalation/rank guard, grants cache | `authorization` skill (+ the contract in `src/common/authorization/README.md`) |
| Auth / login / JWT / OTP / email-verify / phone-verify / lockout / timing hardening / security review | `auth-security` skill |
| Scheduled `@Cron` job (recurring sweep over all due rows) | `scheduled-sweep` skill |
| Background job on the BullMQ queue — immediate / delayed / recurring, with retries, cancellation, rescheduling. **The default for NEW background work**; the decision table at the top of the README says which of the two a job belongs on | `src/common/queue/README.md` |
| Write e2e specs (harness, coverage, cadence, error-envelope assertions) | `e2e-testing` skill |
| Error envelope contract + ErrorCode catalog + client logout rule | `src/common/errors/README.md` |
| Deployment / infra (Caddy + per-env compose + GitHub Actions) | `docs/README.md` → `docs/prod/` + `docs/staging/` |
