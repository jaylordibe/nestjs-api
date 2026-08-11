# NestJS API Template

A production-grade scaffold for building JSON APIs with **NestJS 11 + Prisma 7 + PostgreSQL + Redis**. Click **Use this template** on GitHub, clone, set a few env vars, and start adding feature modules. Security-hardened, documented end-to-end in [`CLAUDE.md`](./CLAUDE.md).

Every e2e spec runs against a **real Postgres and Redis** — no mocks, no in-memory substitutes — so what passes locally is what runs in CI. The suite asserts invariants rather than counts: tenant isolation holds under a forged path parameter, a business never reaches zero owners under concurrent demotion, a replayed refresh token revokes its whole family, and an invitation redeemed twice at the same instant produces one membership.

## What's inside

### Auth & sessions
- **Register** with email verification (JWT link) before first login.
- **Login** with per-route rate limiting and account lockout after 5 failed attempts.
- **Password policy** — 12+ chars, letter + digit, bcrypt cost 12.
- **JWT with `jti`**, bound to service via `iss`/`aud`. `passwordChangedAt` invalidates all outstanding tokens on password rotation.
- **Refresh-token rotation with reuse detection** (RFC 9700 §4.14.2) — every exchange consumes the presented token and issues a new one in the same family. Re-presenting a consumed token is treated as theft and revokes the whole family, **including when the second presentation is concurrent rather than sequential**, which is the case a serial test cannot reach.
- **Per-device logout** (Redis blocklist) + **logout-all** (via `passwordChangedAt` bump).
- **Password reset** via OTP email (separate from verification, 15-min expiry).
- **GDPR erase** endpoint that anonymizes PII + marks `deletedAt`.
- **Timing-safe login** (dummy bcrypt compare for unknown emails).

### Data model
- **Soft delete** via `deletedAt` + `deletedBy` columns, enforced by a global Prisma client extension so deleted rows can't leak through forgotten `WHERE` clauses.
- **Audit columns** (`createdBy`/`updatedBy`/`deletedBy`) on every resource, populated from `@CurrentUser()`.
- **Audit log table** (`audit_logs`) recording every privileged admin action.
- **Three example resources** demonstrating the full CRUD pattern: `Users`, `AppVersions`, `DeviceTokens` (with FK cascade to User).
- **Slack-style tenancy** — one global account, many businesses, exactly one role in each. `BusinessMembership` carries a lifecycle (`invited → active → suspended → left`) rather than a `deletedAt`: the row is reused forever, which is what lets `@@unique([businessId, userId])` be an unconditional constraint. Only `active` confers authority.

### Email
- **Pluggable provider** — `stub` (logs to stdout, default for dev/test) or `resend` (production).
- **Typed Handlebars templates** in `src/common/email/templates/` — variable shapes enforced at compile time.

### Platform
- **Structured logging** via pino (JSON in prod, pretty in dev), with `X-Request-Id` propagation and sensitive-field redaction.
- **Rate limiting** via `@nestjs/throttler` + Redis storage (shared counters across pods).
- **Swagger docs** at `/api/docs`, auto-generated from DTOs (no `@ApiProperty` boilerplate needed — the compiler plugin introspects class-validator).
- **Global exception filters** — Prisma-aware (P2002 → 409, P2003 → 400, P2025 → 404) with a catch-all fallback that never leaks internal error messages in 5xx responses.
- **Config validated at boot** via Joi. Production enforces non-wildcard `CORS_ORIGIN`, explicit `TRUST_PROXY`, and rejects the default `JWT_SECRET`.
- **Background jobs** via BullMQ — immediate, delayed and recurring, with retries + backoff, cancellation, rescheduling, bounded retention, and one logfmt line per lifecycle transition. Three registries (queue / job / recurring schedule) are the single source of truth, and the boot fails on a job with no handler, a queue with no processor, or a recurring schedule Redis still holds that the code no longer declares. Runs in-process by default; `QUEUE_WORKER_ENABLED=false` + `yarn start:worker` splits API and worker with no code change. See [`src/common/queue/README.md`](src/common/queue/README.md).
- **Scheduled jobs** via `@nestjs/schedule` for fixed-cadence sweeps. The decision table at the top of the queue README says which of the two mechanisms a given job belongs on.
- **Health checks** — `/api/health/liveness` (k8s liveness, no DB) + `/api/health/readiness` (DB ping + queue connectivity) + `/api/health/workers` (queue-worker heartbeat, deliberately *off* readiness so a restarting worker can't pull the API out of rotation). All three are unauthenticated, so a failing check logs the real cause and returns a fixed string — Prisma's `P1001`/`P1000` quote your internal host and database user, and an ioredis failure quotes host and port (CWE-209). Enforced by co-located specs on both indicators.
- **Docker** — pinned Postgres 18 + Redis 8 for dev; 3-stage production Dockerfile (non-root, tini, npm stripped).
- **CI** — lint + build + unit + sharded e2e + dependency audit + Trivy image scan on every PR. The audit gate fails on any high/critical advisory *except* ones with a documented, dated exception in `.github/scripts/audit-gate.mjs` — so one genuinely-unfixable finding can't force the choice between a permanently red build and deleting the gate. It also nags when an exception goes stale or past review.
- **DB seeder** — `yarn prisma:seed` creates admin + user accounts from env-configured credentials (idempotent, password-complexity-enforced).

## Setup guide

Requires **Node 24** (see `.nvmrc`), **Yarn 1.22.x**, and **Docker**.

### First-time setup (after cloning)

Run these once when you first clone the repo (or after a teammate adds a new migration / env var).

```bash
# 1. Install dependencies
yarn install

# 2. Configure env (defaults match docker-compose — only JWT_SECRET needs changing)
cp .env.example .env
sed -i '' "s|^JWT_SECRET=.*|JWT_SECRET=\"$(openssl rand -hex 48)\"|" .env

# 3. Start Postgres + Redis (host ports 5433 / 6378 to avoid clashing with local installs)
docker compose up -d

# 4. Generate Prisma client + apply migrations
yarn prisma:generate
yarn prisma:migrate dev --name init

# 5. (Optional) Seed a default admin + user from SEED_* env vars
yarn prisma:seed

# 6. Run the dev server
yarn start:dev
```

Open [http://localhost:3000/api/docs](http://localhost:3000/api/docs) for the live Swagger UI. Health check: [http://localhost:3000/api/health/readiness](http://localhost:3000/api/health/readiness).

### Day-to-day (after initial setup)

The only things you need on a normal workday — start the containers (they'll be stopped if your machine restarted) and run the dev server.

```bash
# 1. Bring Postgres + Redis back up (idempotent — no-op if already running)
docker compose up -d

# 2. Start the dev server in watch mode
yarn start:dev
```

When you're done:

```bash
docker compose down     # stop containers, keep volumes
# or
docker compose down -v  # also wipe postgres-data + redis-data volumes (fresh DB next time)
```

### After pulling changes

When a teammate adds schema changes or new dependencies:

```bash
yarn install                          # if package.json changed
yarn prisma:generate                  # if prisma/schema.prisma changed
yarn prisma:migrate dev               # apply any new migrations
```

### Troubleshooting

- **Port already in use (5433 / 6378)** — something else is bound. `lsof -i :5433` / `:6378` to find it.
- **`JWT_SECRET` boot error** — Joi rejects the template default. Regenerate: `openssl rand -hex 48` → paste into `.env`.
- **Prisma client out of date** — after pulling schema changes, run `yarn prisma:generate`.
- **Stale DB state** — `docker compose down -v && docker compose up -d && yarn prisma:migrate dev` nukes the volume and starts fresh.

## Common commands

| Command | What it does |
| --- | --- |
| `yarn start:dev` | Watch-mode dev server with hot reload |
| `yarn start:prod` | Run the compiled build from `dist/` |
| `yarn start:worker` | Run the queue worker alone, no HTTP server (needs `QUEUE_WORKER_ENABLED=true`) |
| `yarn start:worker:dev` | Same, in watch mode |
| `yarn build` | Compile TypeScript to `dist/` |
| `yarn lint` | ESLint over `src`, `test`, `scripts`, and `prisma` — the gate; never rewrites files |
| `yarn lint:fix` | The same rules with `--fix` — the local fixer, and the only form that edits code |
| `yarn test` | Jest unit tests (`*.spec.ts`, rootDir `src`) |
| `yarn test:e2e` | e2e tests against a real Postgres test DB |
| `yarn prisma:generate` | Regenerate `@prisma/client` after schema edits |
| `yarn prisma:migrate` | Create + apply a migration in dev (interactive) |
| `yarn prisma:deploy` | Apply pending migrations in production (non-interactive) |
| `yarn prisma:seed` | Upsert admin + user from env-driven credentials |
| `yarn prisma:studio` | DB browser |
| `docker compose up -d` / `down` | Start/stop the local Postgres + Redis containers |

## API surface

All routes under `/api`. See Swagger at `/api/docs` for full specs.

### Public
- `POST /auth/register` — creates unverified user, emails verification link. Returns `{ message }` only.
- `POST /auth/login` — returns `{ accessToken, user }`. Rejects with `EmailNotVerified` if email unverified.
- `GET|POST /auth/verify-email` — consumes a JWT verification link.
- `POST /auth/resend-verification` — resends the link (always 200, no enumeration).
- `POST /users/request-password-reset` — emails OTP.
- `POST /users/reset-password` — consumes OTP, sets new password.
- `GET /app-versions` (paginated), `GET /app-versions/:id`, `GET /app-versions/latest?platform=mobile&os=ios` — client update-check flows. `os` names the **release train**: `mobile` and `desktop` ship one independently versioned build per OS, `web` ships one for everyone and omits it.

### Authenticated (JWT)
- `GET /auth/me` — current user.
- `POST /auth/logout` / `POST /auth/logout-all` — per-token / everywhere revocation.
- `GET /users/me`, `GET /users/me/export` (GDPR data access), `PATCH /users/me`, `DELETE /users/me` (soft delete).
- `POST /users/me/gdpr-erase` — PII anonymization + deletion (requires `currentPassword`).
- `PATCH /users/me/{username,email,password,profile-image}` — self-service profile updates.

- `GET /users/me/permissions` — the caller's packed CASL rules, for client-side ability sync.
- `POST|GET|PATCH|DELETE /device-tokens` — your own push tokens (a platform admin manages anyone's).

### Multi-tenant (business scope)
- `POST|GET|PATCH|DELETE /businesses` — any user may create one; the creator becomes its `BUSINESS_OWNER`.
- `.../businesses/:businessId/memberships` — the **one** roster. Staff and customers are the same resource distinguished by role, so there is no parallel tree to keep in step. Rank-guarded: you may never grant a role above your own.
- `.../memberships/:id/{role,suspend,reactivate,transfer-ownership}` — each a separate permission, because CASL's `manage` wildcard would otherwise let anyone holding "update" also assign roles.
- `.../businesses/:businessId/invitations` + `POST /invitations/accept` — invite an address that may not have an account yet. Single-use hashed token; concurrent redemption yields exactly one membership.

### Administrative (platform scope)
- `POST|GET|PATCH|DELETE /users` + `/users/:id` + `/users/:id/password` — full user management.
- `POST|DELETE /users/:userId/roles` — grant/revoke a platform role.
- `GET /roles`, `GET /permissions` — **read-only**. Roles and permissions are both code-owned; there is no endpoint that creates one.
- `GET /queues`, `GET|POST|DELETE /queues/:queue/jobs/:id` — background-job diagnostics and recovery. Job payloads are visible only to `PLATFORM_ENGINEER`; support roles can see a job failed and retry it without reading the user data it carried.
- `POST /users/:id/{unlock,revoke-sessions,resend-verification}` — narrow support capabilities, each its own permission so app support can help an account holder without being able to change their email.
- `GET /audit-logs` — the platform audit trail. Filter by `action` / `actorId` / `targetUserId` / `startCreatedAt` / `endCreatedAt`, or cast a wide net with `?search=`, which matches the action name, either party's email, and the `metadata` envelope as text (trigram-indexed). Rows arrive with `actor` / `targetUser` hydrated (id, email, name, current platform roles), batched one query per page, and still resolve for soft-deleted users.
- `POST|PATCH|DELETE /app-versions` — release signal management.

## Project layout

```
src/
  main.ts                    # bootstrap: helmet, /api prefix, CORS, trust proxy, Swagger
  worker.ts                  # second entrypoint: same AppModule, no HTTP server, consumes queues
  app.module.ts              # global modules + APP_PIPE/INTERCEPTOR/FILTER/GUARD registration
  config/                    # configuration.ts (typed factory), env.validation.ts (Joi)
  prisma/                    # @Global PrismaService + soft-delete extension
  common/
    authorization/           # permission catalog (single source of truth), subject keys, AppAbility
    decorators/              # RequirePermission, AuthenticatedOnly, Public, CurrentUser, CurrentAbility
    dto/                     # MetaQueryDto, PaginatedResponseDto<T>
    enums/                   # RoleScope, PermissionOwnership, SeededRoleName, Gender, AppPlatform, …
    filters/                 # GlobalExceptionFilter (single unified filter)
    email/                   # EmailService, adapters (stub/resend), templates, template engine
    audit/                   # AuditService (@Global)
    redis/                   # RedisService (@Global, shared ioredis client)
    queue/                   # @Global BullMQ layer: registries, producer, processor base, handlers
    scheduled-jobs/          # @Cron host for fixed-cadence sweeps
    util/                    # pure helpers (+ co-located *.util.spec.ts)
  modules/
    auth/                    # AuthService, AuthController, JwtStrategy, JwtAuthGuard
    authorization/           # @Global: AbilityFactory, grants cache, PermissionsGuard, boot-time gates
    users/                   # canonical resource — full CRUD + self-service + GDPR erase
    roles/                   # roles + permissions (both code-owned, read-only) + platform-role assignment
    businesses/              # tenant resource + memberships (staff AND customers) + invitations
    queue-admin/             # operator queue diagnostics; payloads gated behind `readPayload`
    audit-logs/              # read-only audit trail
    app-versions/            # client update signal, one row per release train
    device-tokens/           # push notification tokens (FK to User, hard delete)
    health/                  # liveness + readiness + worker heartbeat
prisma/
  schema.prisma              # models
  migrations/                # a single `init` migration (a starter is a fork in time)
  rbac-seeder.ts             # projects the permission catalog onto the DB (used by rbac:sync)
  seed.ts                    # rbac-seeder + env-driven admin/demo users
test/                        # e2e tests (real Postgres + Redis, no mocks)
```

## Working with Claude Code (optional)

Contributors using [Claude Code](https://code.claude.com) get a **requirement-to-diff pipeline** from the [`engineering-framework`](https://github.com/jaylordibe/claude-engineering-framework) plugin — `/engineering-framework:work-item <key | URL | requirement>` drives work from repository mapping → plan → implement → review → validate → present, stopping at a plan-approval gate and a human Git gate. Install it with `/plugin marketplace add jaylordibe/claude-engineering-framework` then `/plugin install engineering-framework@jaylordibe`.

This repository commits the other half of that contract in `.claude/`: the permission floor (`settings.json`), the repository policy file (`engineering-framework.json`), and five domain playbooks describing *this* API's auth, authorization, resource, sweep, and e2e-harness conventions. See [`CLAUDE.md`](./CLAUDE.md) → **Deep references** for how those pieces fit together. The only per-machine step is a one-time issue-tracker login (`/mcp` → authenticate **atlassian**), and none of it is required to build, run, or test the API.

## Adding a new resource

See [`docs/resource-pattern.md`](./docs/resource-pattern.md) for the full convention and code skeletons. Short version:

1. Add the model to `prisma/schema.prisma` with the standard columns (`id`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy`, optionally `deletedAt`/`deletedBy` for soft delete, optionally `isActive` only when suspension is a distinct concept).
2. Run `yarn prisma:migrate dev --name add_<resource>`.
3. Scaffold `src/modules/<resource>/` with: `dto/` (Create + Update via `PartialType` from `@nestjs/swagger` + Response), `<resource>.module.ts`, `<resource>.service.ts`, `<resource>.controller.ts`.
4. Implement the five standard endpoints in order: `POST /`, `GET /` (paginated), `GET /:id`, `PATCH /:id`, `DELETE /:id`. There is **no unpaginated `GET /all`** — a full-table read OOMs the process once the table grows. Any literal path segment (e.g. `GET /latest`) must be declared **before** `GET /:id`, since NestJS matches routes by declaration order.
5. Register the module in `app.module.ts`.
6. Add e2e tests in `test/<resource>.e2e-spec.ts` (see the three example resources for the pattern).

`CLAUDE.md` covers the deeper stuff: audit-field wiring, soft-delete semantics, per-field error-message customization, security hardening conventions, how to add email templates, and the Prisma soft-delete extension.

## Production checklist

Before the first real deploy, confirm:

- [ ] `JWT_SECRET` regenerated per environment (`openssl rand -hex 48`). Joi refuses the template default at boot.
- [ ] `CORS_ORIGIN` set to an explicit origin list (Joi refuses `*` in `NODE_ENV=production`).
- [ ] `TRUST_PROXY` set to `"1"` or a CIDR list if behind a load balancer (Joi refuses `"false"`/`"true"` in production).
- [ ] `TRUST_CLOUDFLARE_HEADERS` left at `false` **unless** the origin is provably unreachable except through Cloudflare (see the `cloudflare_only` snippet in `docs/prod/Caddyfile`). These headers are forgeable by anyone who can reach the origin directly, and they are written into `audit_logs` — the table an incident responder trusts.
- [ ] `EMAIL_PROVIDER=resend` + `RESEND_API_KEY` + `EMAIL_FROM` (on a verified domain with DKIM/SPF/DMARC in DNS).
- [ ] Error tracker wired (Sentry / Datadog / Axiom — not included; plug into pino or bootstrap).
- [ ] Managed Postgres PITR enabled.
- [ ] Secrets served from a secret manager (AWS Secrets Manager / Vault / k8s secrets) rather than plaintext env.
- [ ] Retention cron scheduled for hard-deleting soft-deleted users after N days (cascades to `device_tokens` via FK).
- [ ] Redis runs with AOF persistence, a durable volume and backups — **queued jobs are exactly as durable as the Redis they live in**, and there is no in-memory fallback by design.
- [ ] `GET /api/health/workers` monitored (it is off readiness on purpose, so nothing else will tell you the worker died).

## Tech stack

- **Runtime** — Node 24 everywhere: `.nvmrc`, `.node-version`, `engines`, the Dockerfile, and CI all name the same major, and `yarn@1.22.22` is pinned via `packageManager`.
- **Framework** — NestJS 11 on Express
- **Language** — TypeScript (strict, `isolatedModules`, `emitDecoratorMetadata`)
- **DB** — PostgreSQL 18 + Prisma 7 via `@prisma/adapter-pg`
- **Cache / sessions** — Redis 8 (ioredis)
- **Background jobs** — BullMQ via `@nestjs/bullmq` (same Redis, AOF-persisted)
- **Cron** — `@nestjs/schedule`
- **Auth** — `@nestjs/jwt` + `passport-jwt`, bcrypt (cost 12)
- **Validation** — class-validator + class-transformer
- **Logging** — pino via `nestjs-pino`
- **Rate limiting** — `@nestjs/throttler` + `@nest-lab/throttler-storage-redis`
- **Email** — `resend` (pluggable via adapter)
- **Docs** — `@nestjs/swagger` (auto-generated from DTOs)
- **Testing** — Jest + supertest (e2e against real Postgres + Redis)

## License

MIT — see [`LICENSE`](./LICENSE).

## Authorization

This template ships DB-backed RBAC with CASL over two scopes: **PLATFORM**
(staff) and **BUSINESS** (tenant-local).

```bash
yarn rbac:sync     # projects the permission catalog + its seeded roles into the DB
yarn rbac:check    # asserts the DB matches the catalog (CI-friendly, exits 1 on drift)
yarn prisma:seed   # rbac:sync + the bootstrap admin/demo users (needs SEED_*)
```

**Roles are code.** There is no `POST /roles` — the catalog in
`src/common/authorization/permission-catalog.ts` is the only place a role is
defined, so granting authority is a reviewable diff rather than an API call.
Four platform roles separate governance (`PLATFORM_ADMIN`) from technical
authority (`PLATFORM_ENGINEER`) from two tiers of support; five business roles
run from owner to customer.

`rbac:sync` runs on **every deploy**, straight after `prisma migrate deploy` —
the api refuses to boot when the catalog and the database disagree, so it can
never be a manual step. It needs only `DATABASE_URL`.

The seeded admin (`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`) gets
`PLATFORM_ADMIN`. **Ordinary accounts get no platform role at all** — platform
roles are staff roles. Self-service over `/users/me/*` and one's own device
tokens comes from `AUTHENTICATED_USER_PERMISSIONS`, which the ability factory
injects for every authenticated caller, so an account with zero roles and zero
memberships is complete rather than broken.

The app **refuses to boot** if (a) the permission catalog and the database
disagree, or (b) any route handler declares no authorization decision. Both are
deliberate: an authorization hole should be a failed deploy, not a 403 nobody
notices.

Clients fetch `GET /users/me/permissions` and rebuild the same CASL ability the
server uses, so UI checks never drift from the backend.

Full contract: [`src/common/authorization/README.md`](src/common/authorization/README.md).
