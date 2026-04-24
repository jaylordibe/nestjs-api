# NestJS API Template

A production-grade scaffold for building JSON APIs with **NestJS 11 + Prisma 7 + PostgreSQL + Redis**. Click **Use this template** on GitHub, clone, set a few env vars, and start adding feature modules. Security-hardened, extensively tested (81 e2e tests), documented end-to-end in [`CLAUDE.md`](./CLAUDE.md).

## What's inside

### Auth & sessions
- **Register** with email verification (JWT link) before first login.
- **Login** with per-route rate limiting and account lockout after 5 failed attempts.
- **Password policy** — 12+ chars, letter + digit, bcrypt cost 12.
- **JWT with `jti`**, bound to service via `iss`/`aud`. `passwordChangedAt` invalidates all outstanding tokens on password rotation.
- **Per-device logout** (Redis blocklist) + **logout-all** (via `passwordChangedAt` bump).
- **Password reset** via OTP email (separate from verification, 15-min expiry).
- **GDPR erase** endpoint that anonymizes PII + marks `deletedAt`.
- **Timing-safe login** (dummy bcrypt compare for unknown emails).

### Data model
- **Soft delete** via `deletedAt` + `deletedBy` columns, enforced by a global Prisma client extension so deleted rows can't leak through forgotten `WHERE` clauses.
- **Audit columns** (`createdBy`/`updatedBy`/`deletedBy`) on every resource, populated from `@CurrentUser()`.
- **Audit log table** (`audit_logs`) recording every privileged admin action.
- **Three example resources** demonstrating the full CRUD pattern: `Users`, `AppVersions`, `DeviceTokens` (with FK cascade to User).

### Email
- **Pluggable provider** — `stub` (logs to stdout, default for dev/test) or `resend` (production).
- **Typed Handlebars templates** in `src/common/email/templates/` — variable shapes enforced at compile time.

### Platform
- **Structured logging** via pino (JSON in prod, pretty in dev), with `X-Request-Id` propagation and sensitive-field redaction.
- **Rate limiting** via `@nestjs/throttler` + Redis storage (shared counters across pods).
- **Swagger docs** at `/api/docs`, auto-generated from DTOs (no `@ApiProperty` boilerplate needed — the compiler plugin introspects class-validator).
- **Global exception filters** — Prisma-aware (P2002 → 409, P2003 → 400, P2025 → 404) with a catch-all fallback that never leaks internal error messages in 5xx responses.
- **Config validated at boot** via Joi. Production enforces non-wildcard `CORS_ORIGIN`, explicit `TRUST_PROXY`, and rejects the default `JWT_SECRET`.
- **Health checks** — `/api/health/liveness` (k8s liveness, no DB) + `/api/health/readiness` (k8s readiness, DB ping).
- **Docker** — pinned Postgres 18 + Redis 8 for dev; 3-stage production Dockerfile (non-root, tini, npm stripped).
- **CI** — lint + build + unit + e2e + yarn audit + Trivy image scan on every PR (Postgres + Redis service containers).
- **DB seeder** — `yarn prisma:seed` creates admin + user accounts from env-configured credentials (idempotent, password-complexity-enforced).

## Setup guide

Requires **Node 22+**, **Yarn 1.x**, and **Docker**.

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
| `yarn build` | Compile TypeScript to `dist/` |
| `yarn lint` | ESLint `--fix` over `src` and `test` |
| `yarn format` | Prettier write |
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
- `GET|GET /app-versions`, `GET /app-versions/all`, `GET /app-versions/:id`, `GET /app-versions/latest?platform=mobile` — for mobile-app update-check flows.

### Authenticated (JWT)
- `GET /auth/me` — current user.
- `POST /auth/logout` / `POST /auth/logout-all` — per-token / everywhere revocation.
- `GET /users/me`, `GET /users/me/export` (GDPR data access), `PATCH /users/me`, `DELETE /users/me` (soft delete).
- `POST /users/me/gdpr-erase` — PII anonymization + deletion (requires `currentPassword`).
- `PATCH /users/me/{username,email,password,profile-image}` — self-service profile updates.

### Admin-only (`@Roles(Role.ADMIN)`)
- `POST|GET|PATCH|DELETE /users` + `/users/:id` + `/users/:id/password` — full user management.
- `POST|PATCH|DELETE /app-versions` + `/app-versions/:id` — release signal management.
- `POST|GET|PATCH|DELETE /device-tokens` + `/device-tokens/:id` — push token management.

## Project layout

```
src/
  main.ts                    # bootstrap: helmet, /api prefix, CORS, trust proxy, Swagger
  app.module.ts              # global modules + APP_PIPE/INTERCEPTOR/FILTER/GUARD registration
  config/                    # configuration.ts (typed factory), env.validation.ts (Joi)
  prisma/                    # @Global PrismaService + soft-delete extension
  common/
    decorators/              # Roles, CurrentUser, Public
    dto/                     # PaginationQueryDto, PaginatedResponseDto<T>
    enums/                   # Role, Gender, AppPlatform, DeviceType, DeviceOs, OtpPurpose
    guards/                  # RolesGuard (reads Roles metadata)
    filters/                 # AllExceptionsFilter + PrismaExceptionFilter
    email/                   # EmailService, adapters (stub/resend), templates, template engine
    audit/                   # AuditService (@Global)
    redis/                   # RedisService (@Global, shared ioredis client)
  modules/
    auth/                    # AuthService, AuthController, JwtStrategy, JwtAuthGuard
    users/                   # canonical resource — full CRUD + self-service + GDPR erase
    app-versions/            # mobile app version signal
    device-tokens/           # push notification tokens (FK to User, hard delete)
    health/                  # liveness + readiness
prisma/
  schema.prisma              # models
  migrations/                # DB migration history
  seed.ts                    # env-driven admin + user seeder
test/                        # e2e tests (real Postgres + Redis, no mocks)
```

## Adding a new resource

See [`CLAUDE.md`](./CLAUDE.md) → **"Generating a new resource"** for the full convention. Short version:

1. Add the model to `prisma/schema.prisma` with the standard columns (`id`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy`, optionally `deletedAt`/`deletedBy` for soft delete, optionally `isActive` only when suspension is a distinct concept).
2. Run `yarn prisma:migrate dev --name add_<resource>`.
3. Scaffold `src/modules/<resource>/` with: `dto/` (Create + Update via `PartialType` from `@nestjs/swagger` + Response), `<resource>.module.ts`, `<resource>.service.ts`, `<resource>.controller.ts`.
4. Implement the six standard endpoints in order: `POST /`, `GET /` (paginated), `GET /all`, `GET /:id`, `PATCH /:id`, `DELETE /:id`. **`/all` must be declared before `/:id`** — NestJS matches routes by declaration order.
5. Register the module in `app.module.ts`.
6. Add e2e tests in `test/<resource>.e2e-spec.ts` (see the three example resources for the pattern).

`CLAUDE.md` covers the deeper stuff: audit-field wiring, soft-delete semantics, per-field error-message customization, security hardening conventions, how to add email templates, and the Prisma soft-delete extension.

## Production checklist

Before the first real deploy, confirm:

- [ ] `JWT_SECRET` regenerated per environment (`openssl rand -hex 48`). Joi refuses the template default at boot.
- [ ] `CORS_ORIGIN` set to an explicit origin list (Joi refuses `*` in `NODE_ENV=production`).
- [ ] `TRUST_PROXY` set to `"1"` or a CIDR list if behind a load balancer (Joi refuses `"false"`/`"true"` in production).
- [ ] `EMAIL_PROVIDER=resend` + `RESEND_API_KEY` + `EMAIL_FROM` (on a verified domain with DKIM/SPF/DMARC in DNS).
- [ ] Error tracker wired (Sentry / Datadog / Axiom — not included; plug into pino or bootstrap).
- [ ] Managed Postgres PITR enabled.
- [ ] Secrets served from a secret manager (AWS Secrets Manager / Vault / k8s secrets) rather than plaintext env.
- [ ] Retention cron scheduled for hard-deleting soft-deleted users after N days (cascades to `device_tokens` via FK).

## Tech stack

- **Runtime** — Node 22+ (Node 24 in CI and Docker)
- **Framework** — NestJS 11 on Express
- **Language** — TypeScript (strict, `isolatedModules`, `emitDecoratorMetadata`)
- **DB** — PostgreSQL 18 + Prisma 7 via `@prisma/adapter-pg`
- **Cache / sessions** — Redis 8 (ioredis)
- **Auth** — `@nestjs/jwt` + `passport-jwt`, bcrypt (cost 12)
- **Validation** — class-validator + class-transformer
- **Logging** — pino via `nestjs-pino`
- **Rate limiting** — `@nestjs/throttler` + `@nest-lab/throttler-storage-redis`
- **Email** — `resend` (pluggable via adapter)
- **Docs** — `@nestjs/swagger` (auto-generated from DTOs)
- **Testing** — Jest + supertest (e2e against real Postgres + Redis)

## License

MIT — see [`LICENSE`](./LICENSE).
