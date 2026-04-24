# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

NestJS API template — NestJS 11 (TypeScript, Express) + Prisma 7 + PostgreSQL. JWT auth with role-based access control (`ADMIN`, `USER`). Intended as a GitHub template: spin up a new repo, set `SERVICE_NAME` in `.env`, and start adding feature modules. URLs are unversioned (`/api/...`) — add Nest URI versioning later if/when a v2 becomes necessary.

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
- `yarn prisma:seed` — upserts the default admin + user from `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`/`SEED_USER_EMAIL`/`SEED_USER_PASSWORD` env vars. Idempotent: if a row with that email already exists, it's left untouched — the seed never rewrites an operator's in-flight password change. Password complexity (12+ chars, letter + digit) is enforced at seed time since the script bypasses the HTTP validation pipeline. Config lives in `prisma.config.ts` under `migrations.seed`.
- `yarn prisma:studio` — DB browser
- `docker compose up -d` — start the local Postgres 18 + Redis 8 containers. Compose requires `SERVICE_NAME`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`/`DB_PORT`/`REDIS_PORT`/`REDIS_PASSWORD` to be set in `.env` — there are no fallbacks, so a missing key fails fast. With the values shipped in `.env.example` (`SERVICE_NAME=nestjs`, `DB_USER=${SERVICE_NAME}`, `DB_NAME=${SERVICE_NAME}_local`), you get container `nestjs-postgres`, role `nestjs`, and DB `nestjs_local` — i.e. the app connects as a per-service role rather than the generic `postgres` superuser, mirroring the least-privilege pattern used in managed prod (RDS/Cloud SQL). Host ports are **5433** (postgres) and **6378** (redis) to avoid clashing with host-installed instances on the standard 5432/6379; both containers still listen on their canonical ports internally.
  - **Postgres image** is **`postgres:18.3`** (Debian/glibc, fully pinned), **not** Alpine. Postgres 18 is the current latest stable per postgresql.org and is officially recommended for new production deployments. Reasons for this exact pin: (1) managed Postgres providers (RDS, Cloud SQL, Neon, Supabase) all run on glibc, and Postgres text collation is libc-dependent — running Alpine (musl) locally can produce different sort orders / index behavior than prod; (2) pinning to `18.3` (no `-bookworm` suffix needed — bare minor pulls the Debian variant) means an upstream image rebuild can't surprise you with a patch-level skew. Bump the pin deliberately when you bump prod. The cluster is initialized with `POSTGRES_INITDB_ARGS=--encoding=UTF-8 --locale=C.UTF-8` so encoding/collation is deterministic across hosts. `shm_size: 256mb` raises the default 64mb so parallel queries and `work_mem`-heavy plans don't trip "could not resize shared memory segment" errors that wouldn't appear on a real prod box.
  - **Redis image** is **`redis:8.6.2`** (Debian, fully pinned). Started with `--requirepass ${REDIS_PASSWORD}` so it refuses unauthenticated connections (matches managed Redis providers like ElastiCache/Memorystore/Upstash, which always require auth). `--appendonly yes` enables AOF persistence — durable across restarts, matching prod expectations. The Redis 8 license question (relicensed to RSALv2/SSPL/AGPLv3 dual) does **not** affect self-hosted use; only managed-service providers have to care. Connection details are surfaced as both discrete (`redis.host`, `redis.port`, `redis.password`) and as a connection URL (`redis.url`) for clients that prefer one form over the other.
- `docker compose down` (add `-v` to wipe both data volumes — `postgres-data` and `redis-data`)

First-time setup: `docker compose up -d`, copy `.env.example` → `.env` (the defaults already match the compose file — only `JWT_SECRET` needs changing), then `yarn prisma:generate && yarn prisma:migrate dev --name init`.

## Docker

- `docker-compose.yml` runs Postgres + Redis so dev keeps using `yarn start:dev` for hot reload against the dockerized services.
- `Dockerfile` is a 3-stage production build (`deps` → `build` → `runtime`). The `build` stage runs `prisma generate` + `nest build` then prunes to prod deps; `runtime` is `node:24-alpine` + `tini`, runs as non-root `app` user, ships `dist/`, `node_modules/`, and `prisma/` (so `prisma migrate deploy` is available at deploy time). Run migrations as a separate step (init container, deploy hook, etc.) — the entrypoint is just `node dist/main.js`.
- `.dockerignore` excludes `node_modules`, `dist`, `.env*` (except `.env.example`), tests, IDE files.

## Architecture

```
src/
  main.ts              # bootstrap: helmet, prefix /api, trust proxy, CORS, shutdown hooks
  app.module.ts        # ConfigModule + ThrottlerModule + PrismaModule + feature modules;
                       # registers global APP_PIPE (ValidationPipe), APP_INTERCEPTOR (ClassSerializerInterceptor),
                       # APP_FILTER (AllExceptionsFilter), APP_GUARD (ThrottlerGuard)
  config/              # configuration.ts (typed factory), env.validation.ts (Joi schema)
  prisma/              # @Global() PrismaModule + PrismaService (extends PrismaClient, OnModuleInit/Destroy)
  common/
    decorators/        # Roles, CurrentUser (+ AuthenticatedUser type), Public (skips JwtAuthGuard)
    guards/            # RolesGuard (Reflector-based, reads ROLES_KEY metadata)
    filters/           # AllExceptionsFilter (catch-all) + PrismaExceptionFilter (translates P2002/P2025 to 409/404)
    dto/               # PaginationQueryDto, PaginatedResponseDto<T>, PaginationMeta (shared by every list endpoint)
    enums/             # Role, Gender, OtpPurpose, AppPlatform, DeviceType, DeviceOs — TS-only enums (no DB enums — see "Generating a new resource")
    email/             # EmailService (@Global) — stub dev adapter; swap the provider to wire SES/SendGrid/etc.
    audit/             # AuditService (@Global) — append-only `audit_logs` writes for privileged actions. Best-effort (logs but never throws on failure).
    redis/             # RedisService (@Global) — shared ioredis client for app-level use (JWT logout blocklist). Separate from the throttler's internal Redis client.
  modules/
    auth/              # AuthService, AuthController, JwtStrategy, JwtAuthGuard, login/register DTOs (per-route stricter throttle)
    users/             # UsersService, controller, DTOs (Create/Update/Response) — canonical resource pattern
    health/            # @nestjs/terminus: GET /health/liveness (memory) + GET /health/readiness (DB ping via PrismaHealthIndicator)
prisma/schema.prisma   # PostgreSQL datasource; User model
```

Endpoints (all under `/api`):
- **Auth** — `POST /auth/register` is the single public registration path (no `/users/sign-up` alias — the two used to exist, they were collapsed). Takes only `{ email, password, firstName, lastName }` (`RegisterDto` is `PickType(CreateUserDto, [...])`), creates an *unverified* user, emails the verification link, and returns **only `{ message }`** — no user object, no access token. `POST /auth/login` rejects `EmailNotVerified` after successful password match if `emailVerifiedAt` is null. `POST|GET /auth/verify-email` (public; accepts a JWT link token signed with `purpose: 'email_verify'`). `POST /auth/resend-verification` (public, strictly throttled 3/min, always 200 to avoid enumeration). `GET /auth/me`, `POST /auth/logout` (revokes the current token's `jti` via Redis blocklist), `POST /auth/logout-all` (bumps `passwordChangedAt` so every outstanding token for the user is rejected). The `/me`/`logout`/`logout-all` routes use `JwtAuthGuard`. Login + register override the global throttle with stricter per-route limits (10/min and 5/min).
- **Admin-only `POST /users`**: creates a user with the full `CreateUserDto` shape (all profile fields, role selectable). This is **not** a public registration path — it's for admin seeding / operational creates. Public sign-up happens at `/auth/register`.
- **Users** — the class has `@UseGuards(JwtAuthGuard, RolesGuard)`; each handler declares its own `@Roles(...)` (or `@Public()` for unauthenticated endpoints). Split:
  - **Public**: `POST /users/sign-up` (delegates to `AuthService.register`; returns `{ accessToken, user }`), `POST /users/request-password-reset` (always 200 regardless of whether email is registered — no enumeration), `POST /users/reset-password` (consumes OTP; sets new password; bumps `passwordChangedAt`, clearing active tokens). All three carry `@Throttle({ limit: 5, ttl: 60_000 })`.
  - **Self-service** (any authenticated user; no `@Roles`): `GET /users/me`, `GET /users/me/export` (GDPR data access), `PATCH /users/me` (profile fields only), `DELETE /users/me` (soft delete — sets `deletedAt` + `deletedBy`; `isActive` is untouched because it's reserved for suspension, not double-signalling deletion), `POST /users/me/gdpr-erase` (right-to-be-forgotten — anonymizes every PII column; requires `currentPassword`), `PATCH /users/me/username`, `PATCH /users/me/email` (requires `currentPassword`; resets `emailVerifiedAt`), `PATCH /users/me/password` (requires `currentPassword`), `PATCH /users/me/profile-image`, `POST /users/me/request-email-verification` (issues OTP via email), `POST /users/verify-email` (consumes OTP).
  - **Admin** (`@Roles(Role.ADMIN)`): `POST /users`, `GET /users` (paginated, `?page=1&perPage=20`, max 100), `GET /users/all`, `GET /users/:id` (still returns soft-deleted rows so admins can recover them), `PATCH /users/:id`, `PATCH /users/:id/password` (no current-password check — refused if target is the actor; see H3 in Security model), `DELETE /users/:id` (soft delete — sets `deletedAt`; row remains for audit/recovery). All admin mutations write an `audit_logs` entry via `AuditService`.
- **Health** — `GET /health/liveness` (process memory heap < 512MB — for k8s liveness; must NOT depend on DB), `GET /health/readiness` (DB `SELECT 1` — for readiness/LB probes; returns 503 if DB is down).

## Generating a new resource

Every new resource (`orders`, `products`, etc.) follows the users pattern *exactly*. When scaffolding, produce all of the following without being asked.

### Required schema columns

Every table has these columns, in this physical order, before resource-specific fields:

```prisma
model Order {
  id              String    @id @default(uuid()) @db.Uuid
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  createdBy       String?   @db.Uuid
  updatedBy       String?   @db.Uuid
  deletedAt       DateTime? // only for soft-delete resources — see "Delete semantics"
  deletedBy       String?   @db.Uuid // pairs with deletedAt — who performed the soft delete
  isActive        Boolean   @default(true) // only when the resource has a distinct suspension/pause state — see "Business state vs lifecycle"
  // resource-specific fields below this line
  @@map("orders")
}
```

**Required**: `id`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy`. Column order groups at/by pairs (`createdAt`/`createdBy`, `updatedAt`/`updatedBy`) then lifecycle metadata (`deletedAt`/`deletedBy`, if applicable) then business state (`isActive`, if applicable) — matches the mental model of "provenance, then lifecycle, then what the row actually is."

**Opt-in, pair-wise**:
- `deletedAt` + `deletedBy`: add when the resource uses soft delete (see **Delete semantics**). `deletedBy` completes the `createdBy`/`updatedBy`/`deletedBy` audit trio — it survives restore-then-re-delete cycles (where `updatedBy` would get overwritten) and answers "who killed this?" without a join to `audit_logs`.
- `isActive`: add only when the resource has a distinct business-state toggle separate from deletion (see **Business state vs lifecycle**). Don't add it reflexively — most resources don't need it, and having it there but unused is dead weight that misleads readers.

The `User` model additionally carries auth-specific columns (`passwordChangedAt`, `failedLoginCount`, `lockedUntil`, `deletedAt`, `deletedBy`) — see **Security model** and **Delete semantics** below.

### Business state vs lifecycle

`isActive` is **suspension** (business state: admin paused the user, subscription expired but row kept for reactivation). `deletedAt` is **deletion** (lifecycle: the row is logically gone). These are different concepts — don't conflate them.

Decide per resource whether the business-state distinction is meaningful:

- **Has a real suspension concept** → add `isActive`. Example: `User` (admin suspends for ToS violation / support investigation without deleting the account).
- **No separate suspension state** → skip `isActive`. Example: `DeviceToken` (push tokens either exist or don't — there's no "muted but registered" workflow). Example: `AppVersion` (the table is a release signal, not a catalog — a bad release gets deleted and replaced, not deactivated).

When you add `isActive`, wire it into the paths that care: auth guards for `User`, list filters for public-facing catalogs, etc. When you skip it, the resource's delete path is cleaner (just `deletedAt` for soft, or `prisma.delete` for hard), and readers aren't left wondering why a field exists but is never meaningfully set.

**For `User` specifically**: `isActive` defaults to `true` on create. The soft-delete and GDPR-erase paths don't touch it — `deletedAt` is the lifecycle gate, `isActive` is reserved for explicit suspension. Auth hot paths (`AuthService.login`, `JwtStrategy.validate`) reject on any of: soft-deleted (via `prisma.scoped`), `!isActive` (suspended), or `lockedUntil > now` (brute-force lockout). Three independent reasons; none conflated.

- `id` — UUID, always. Never use integer PKs.
- `createdAt` / `updatedAt` — Prisma-managed timestamps.
- `createdBy` / `updatedBy` — nullable UUIDs of the acting user. Nullable because system-created rows and unauthenticated creates (e.g. registration) have no actor. **Wiring them is the service's job — see "Audit fields" below.**
- `isActive` — soft-delete / toggle flag. Prefer `isActive = false` over hard delete for user-visible resources so the audit trail is preserved. Hard delete only for truly ephemeral data.

### No DB enums

Enum-like columns (status, type, role, gender) are stored as `String`. Constrain values with a TS enum in `src/common/enums/<name>.enum.ts` and validate inputs with `@IsEnum(MyEnum)` on the DTO. Reason: enum values are the most likely thing to grow; changing a DB enum requires a migration, changing a TS enum doesn't.

**Enum style** — UPPER_SNAKE keys, lowercase_snake string values:

```ts
export enum OrderStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELED = 'canceled',
}
```

The DB stores the lowercase form (`'in_progress'`); TS code uses the enum (`OrderStatus.IN_PROGRESS`). At the DB→app boundary (e.g. JWT strategy reading `user.role`), cast: `user.role as Role`.

### Module layout

```
src/modules/<resource>/
  dto/
    create-<resource>.dto.ts     # class-validator annotations; no audit/system fields
    update-<resource>.dto.ts     # extends PartialType(Create<Resource>Dto); optionally adds isActive
    <resource>-response.dto.ts   # shape sent to clients; @Exclude() sensitive cols
  <resource>.module.ts
  <resource>.service.ts
  <resource>.controller.ts
```

Register the module in `app.module.ts` imports. `PrismaModule` is `@Global()`, so the new module doesn't need to import it.

### Standard endpoints (always these six, in this order)

| Verb   | Path                | Method          | Returns                                        |
|--------|---------------------|-----------------|------------------------------------------------|
| POST   | `/<resource>`       | `create`        | `<Resource>ResponseDto`                        |
| GET    | `/<resource>`       | `findPaginated` | `PaginatedResponseDto<<Resource>ResponseDto>`  |
| GET    | `/<resource>/all`   | `findAll`       | `<Resource>ResponseDto[]`                      |
| GET    | `/<resource>/:id`   | `findOne`       | `<Resource>ResponseDto`                        |
| PATCH  | `/<resource>/:id`   | `update`        | `<Resource>ResponseDto`                        |
| DELETE | `/<resource>/:id`   | `remove`        | `void` (204)                                   |

Rules:

- **Declaration order matters.** NestJS (Express) matches routes in declaration order, so `@Get('all')` must appear before `@Get(':id')` — otherwise `/all` gets captured by the UUID param and fails in `ParseUUIDPipe` with 400. Any future static path (`/search`, `/stats`) needs the same treatment.
- **Paginated list** uses `PaginationQueryDto` from `src/common/dto/` and wraps results in `PaginatedResponseDto<T>`. Defaults: `page=1`, `perPage=20`, max `perPage=100`. Query-param pair is `page` + `perPage` (matching GitHub's `per_page` style); the matching meta shape is `{ page, perPage, total, totalPages }`.
- **`/all` is unpaginated** — fine for dropdowns, exports, tables under a few thousand rows. If a resource can grow past that, document which endpoint callers should prefer, or add a hard cap inside the service. Callers who want more than 100 rows at a time should prefer `/all` over raising the `perPage` cap.
- **PATCH, not PUT.** `Update<Resource>Dto = PartialType(Create<Resource>Dto)` — all fields optional, matching partial-update semantics. PUT's "replace entire resource" would need a separate DTO with required non-nullable fields and explicit null-ing of omitted ones; not worth it for CRUD.
- **DELETE returns 204** via `@HttpCode(HttpStatus.NO_CONTENT)`. Whether the service hard-deletes or soft-deletes depends on the resource — see **Delete semantics** below.
- **UUID params** use `@Param('id', new ParseUUIDPipe())`.

### Controller skeleton

```ts
@Controller('orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)                       // or specific roles; omit @Roles for "any authenticated user"
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  async create(
    @Body() dto: CreateOrderDto,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<OrderResponseDto> {
    return new OrderResponseDto(await this.ordersService.create(dto, current.id));
  }

  @Get()
  async findPaginated(
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<OrderResponseDto>> {
    const { data, meta } = await this.ordersService.findPaginated(query);
    return { data: data.map((r) => new OrderResponseDto(r)), meta };
  }

  // Must be before @Get(':id'). See "Declaration order matters" above.
  @Get('all')
  async findAll(): Promise<OrderResponseDto[]> {
    const rows = await this.ordersService.findAll();
    return rows.map((r) => new OrderResponseDto(r));
  }

  @Get(':id')
  async findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<OrderResponseDto> {
    return new OrderResponseDto(await this.ordersService.findById(id));
  }

  @Patch(':id')
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateOrderDto,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<OrderResponseDto> {
    return new OrderResponseDto(await this.ordersService.update(id, dto, current.id));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.ordersService.remove(id);
  }
}
```

### Service skeleton

- `create(dto, actorId)` — set `createdBy: actorId, updatedBy: actorId`.
- `findAll()` — `orderBy: { createdAt: 'desc' }`, no pagination, no filters.
- `findPaginated(query)` — `findMany({ skip, take, orderBy })` + `count()` inside **one** `prisma.$transaction([...])` so the total matches the page.
- `findById(id)` — throws `NotFoundException` when missing. Pair with `findByIdOrNull(id)` for non-throwing lookups (JwtStrategy needs the non-throwing form to return 401 instead of 404).
- `update(id, dto, actorId)` — set `updatedBy: actorId`. Don't touch `createdBy`. Re-check existence first so a missing row throws 404, not a Prisma P2025.
- `remove(id, actorId)` — hard delete via `prisma.<model>.delete` for transient/operational resources, or `update({ deletedAt: new Date() })` for resources with retention value. Pick based on the **Delete semantics** rules below.
- **Don't try/catch Prisma errors in services.** `PrismaExceptionFilter` (global, registered in `app.module.ts`) catches `PrismaClientKnownRequestError` and translates `P2002 → 409 Conflict` (message derived from `err.meta.target`, e.g. "Email already in use"), `P2025 → 404 Not Found`, and anything else → 500. Let the errors bubble up.

### Audit fields

`createdBy` / `updatedBy` do **not** auto-populate — every mutating service method takes `actorId: string | null` and writes it:

```ts
create(dto: CreateOrderDto, actorId: string | null) {
  return this.prisma.order.create({
    data: { ...dto, createdBy: actorId, updatedBy: actorId },
  });
}
```

Controllers pass `@CurrentUser().id`. For unauthenticated creates (registration via `AuthService.register`) pass `null`. The users module follows this convention (see `UsersController.create`/`update` and `AuthService.register`). A request-scoped Prisma extension that sets these automatically across every model is a possible future improvement, but the explicit-arg pattern is deliberately chosen for now — it makes the actor visible at every callsite.

### Response DTO

Mirror the schema's column order: `id, createdAt, updatedAt, createdBy, updatedBy, isActive, ...resource fields`. Always construct via `new <Resource>ResponseDto(row)`; the global `ClassSerializerInterceptor` then strips `@Exclude()`-marked fields automatically. **Never return raw Prisma rows from a controller** — secrets (passwords, OTP hashes, tokens) leak otherwise.

```ts
export class OrderResponseDto {
  id!: string;
  createdAt!: Date;
  updatedAt!: Date;
  createdBy!: string | null;
  updatedBy!: string | null;
  isActive!: boolean;
  // resource-specific fields
  @Exclude() secretColumn!: string | null;
  constructor(row: Order) { Object.assign(this, row); }
}
```

### Migration

Edit `prisma/schema.prisma`, then `yarn prisma:migrate dev --name add_<resource>`. **Until any deployed environment (staging/prod) has applied migrations, feel free to edit migration files in place** — collapse, reorder, rewrite. After the first real deploy, stop: Prisma records each applied migration's checksum in `_prisma_migrations` and drift-errors if an existing file changes. From that point on, only add new migrations.

### E2E test

Required for every resource. Create `test/<resource>.e2e-spec.ts` — see "Adding a new e2e spec" below. Minimum coverage: each of the six endpoints + access-control (401 unauthenticated, 403 wrong role if applicable) + pagination (meta shape, invalid params → 400).

## Cross-cutting conventions

- **Security headers**: `helmet()` is wired in `main.ts` before any route handler, applying the standard set of OWASP-recommended HTTP headers (CSP, HSTS, X-Frame-Options, etc.). Don't disable without a reason.
- **Rate limiting**: `@nestjs/throttler` is registered globally as an `APP_GUARD` in `app.module.ts`, configured from `THROTTLE_TTL_MS` / `THROTTLE_LIMIT` env vars (default: 100 req / 60s / IP). Override per-route with `@Throttle({ default: { limit, ttl } })` — auth endpoints already do this. Disable per-route with `@SkipThrottle()` (used on `/health/*` so probes never get rate-limited).
- **Trust proxy**: `main.ts` calls `app.set('trust proxy', config.trustProxy)` from the `TRUST_PROXY` env var. Default is `"false"` (direct exposure). When deploying behind nginx/ALB/Cloudflare/k8s ingress, set it to `"1"` (single hop) or a comma-separated CIDR list — otherwise `req.ip` is the proxy's IP and per-IP throttling collapses into one global bucket. Never set to `"true"` in prod (lets clients spoof `X-Forwarded-For`).
- **Validation is global**: `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } })` is registered as `APP_PIPE` in `app.module.ts`. Add a DTO for every request body/query — extra fields → 400. Query-string numbers (`?page=2`) auto-convert to `number` thanks to `enableImplicitConversion`.
- **Response serialization**: global `ClassSerializerInterceptor` (`APP_INTERCEPTOR` in `app.module.ts`). Controllers return DTO instances (`new <Resource>ResponseDto(row)`); `@Exclude()`-marked fields are stripped before JSON. Never return raw Prisma rows.
- **Auth payload shape**: JWT carries `{ sub, email, role }`. `JwtStrategy.validate` re-fetches the user **by `sub`** via `UsersService.findByIdOrNull` (non-throwing, so a missing user surfaces as 401, not 404), checks `isActive`, and returns `AuthenticatedUser` (the `request.user` shape). Use `@CurrentUser()` to read it; it returns `AuthenticatedUser`, NOT a full `User`. If you need the full row in a handler, call `usersService.findById(currentUser.id)`.
- **Role-based access**: `@UseGuards(JwtAuthGuard, RolesGuard)` at the class, then either `@Roles(Role.ADMIN)` on handlers that need admin, or no `@Roles` on handlers any authenticated user can hit. `RolesGuard` is a no-op when `@Roles()` is absent, so the handler-level decorator is what actually gates access. For mixed public/private within one controller, use `@Public()` on the public handlers — the `JwtAuthGuard` honors it and skips authentication. Role values in the DB are lowercase (`'admin'`, `'user'`) per the enum-style convention above.
- **Cross-module forward refs**: when a controller needs a service from a module that already imports back (e.g. `UsersController` needs `AuthService`, and `AuthModule` imports `UsersModule`), break the cycle with `forwardRef` in both `imports` and the `@Inject` constructor parameter. See `users.module.ts` ↔ `auth.module.ts` + `UsersController`.
- **Prisma access** goes through `PrismaService` (DI-injected). The module is `@Global()` — no need to re-import.
- **Unique-constraint violations & not-found errors** are translated by the global `PrismaExceptionFilter` — P2002 → 409 Conflict with a field-aware message (`"Email already in use"` / `"Username already in use"` / generic fallback), P2025 → 404. Services should not wrap Prisma calls in try/catch for these; the filter handles them uniformly across every resource. Custom message per field is handled inside the filter by dispatching on `err.meta.target`.
- **APP_FILTER ordering**: global filters are LIFO — the **last** registered is tried first. `PrismaExceptionFilter` must be registered after `AllExceptionsFilter` so the specific filter gets first crack at Prisma errors before the catch-all runs. `app.module.ts` already does this.
- **Config access**: `configService.getOrThrow<T>('jwt.secret')` etc. — keys are dot-paths into `configuration.ts`. Don't read `process.env` directly outside `configuration.ts`.
- **`SERVICE_NAME` is the single source of truth** for the service identifier. It's exposed at `configService.get('serviceName')` and used to derive `DB_NAME` (which defaults to `${SERVICE_NAME}_local` via dotenv-expand — the `_local` suffix keeps the dev DB visually distinct from any same-named DB on a shared host). `DB_NAME` then drives the Postgres database name in compose and the `${DB_NAME}` slot in `DATABASE_URL`. Change `SERVICE_NAME` → DB name and URL follow automatically; override `DB_NAME` explicitly if you ever need the DB name to diverge (e.g., a parallel branch DB or a non-`_local` env). The compose container name uses `SERVICE_NAME` directly. `db.name` is also exposed at `configService.get('database.name')` for app-level use. Both `@nestjs/config` (`expandVariables: true`) and the Prisma CLI support `${VAR}` expansion in `.env`; modern docker-compose (v2+) interpolates variables within `.env` too.

### Security model

The template ships with a specific set of hardening decisions. Know these before relaxing any of them — each was a deliberate fix for a realistic attack.

- **`JWT_SECRET` is required and validated** (`env.validation.ts`): Joi `.min(32).required().invalid(...)`. The `invalid()` clause rejects the exact string that once shipped in `.env.example` so an existing clone can't silently deploy with the template default. Regenerate per environment: `openssl rand -hex 48`.
- **`JWT_EXPIRES_IN` defaults to `30d`** — matches consumer-app norms for booking/social/content apps. The security model relies on `passwordChangedAt`-based invalidation (below) rather than short expiry to limit the blast radius of token theft. For higher-value apps (banking, healthcare, admin consoles), drop to `1h` and layer on a refresh-token flow.
- **JWT `issuer` + `audience` are bound to `SERVICE_NAME`** on both signing (`auth.module.ts`) and verification (`jwt.strategy.ts`). Tokens from one service can't be replayed against another even if they share a secret.
- **Token invalidation on password change**: `User.passwordChangedAt` is written on create and every password update. `JwtStrategy.validate` rejects tokens whose `iat` is in a strictly earlier second than `passwordChangedAt`. Stolen tokens stop working the moment the real user rotates their password. Sub-second tolerance is built in so a freshly-issued token from the same login doesn't false-reject itself.
- **Logout — per-token revocation**: every issued JWT carries a `jti` claim (random UUID, set via `jwtid` in `JwtModule` sign options). `POST /auth/logout` writes `logout:jti:<jti>` to Redis with a TTL matching the token's remaining lifetime (derived from the `exp` claim), so the key expires on its own — no cleanup job. `JwtStrategy.validate` does an `EXISTS` check per request; if the jti is blocklisted, the token is rejected. **Fail-open on Redis outage** (warning logged, request allowed through) so a Redis incident doesn't cascade into an auth blackout. Consequence: revocations are best-effort while Redis is unreachable, but that's a better tradeoff than a total login failure; if you're doing a forced session invalidation for a security incident, use `logout-all` (which uses Postgres, not Redis).
- **Logout-all — session-wide revocation**: `POST /auth/logout-all` bumps the user's `passwordChangedAt` to now, which the existing `iat < passwordChangedAt` check in `JwtStrategy` rejects on every outstanding token for that user. Uses Postgres (not Redis), so it's unaffected by Redis availability. Use when the user suspects compromise but isn't ready to change their password yet.
- **Admin self-target on `PATCH /users/:id/password` is refused**: `UsersService.updatePasswordAsAdmin` throws 403 when `userId === actorId`. Admins must use `/me/password` (which requires the current password) to change their own — blocks session-hijack → permanent account takeover.
- **Account lockout on failed logins**: 5 failed attempts → `lockedUntil = now + 15m`; successful login clears the counter. Tracked in `User.failedLoginCount` + `User.lockedUntil`. Combined with the per-IP throttle (10/min on `/auth/login`), distributed brute force is constrained.
- **Login timing normalized**: when the email isn't registered, `AuthService.login` still runs a bcrypt compare against a lazy-computed dummy hash so wall-clock time doesn't distinguish "unknown user" from "wrong password". Closes the email enumeration vector.
- **bcrypt cost = 12** (`users.service.ts:BCRYPT_ROUNDS`). OWASP 2024 guidance.
- **Password policy**: `@MinLength(12)` + `@MaxLength(72)` (bcrypt truncation guard) + regex requiring at least one letter and one digit. Applied on create/sign-up and every "new password" field (not `currentPassword` fields, which must accept legacy values for re-auth).
- **Sign-up rate-limited**: `@Throttle({ limit: 5, ttl: 60_000 })` on `POST /users/sign-up` (same as `/auth/register`). Prevents mass-account creation per IP.
- **`@Public()` decorator**: `src/common/decorators/public.decorator.ts` + handled in `JwtAuthGuard`. Use sparingly — currently only `sign-up`. Any public endpoint that accepts user-controlled input needs its own `@Throttle(...)` too; the global 100/min is too loose for public endpoints.
- **Generic 500 responses**: `AllExceptionsFilter` returns `"Internal server error"` for non-`HttpException` errors; the real message is logged server-side. Prevents leaking Prisma/Node internals (hostnames, file paths) to clients.
- **Password, OTP hash, `passwordChangedAt`, `failedLoginCount`, `lockedUntil`** are all `@Exclude()`-marked in `UserResponseDto`. Never build a response that serializes these directly — always go through the DTO.
- **Soft-deleted users are blocked from auth**: `AuthService.login` and `JwtStrategy.validate` both reject when `deletedAt IS NOT NULL`. Combined with `passwordChangedAt` (rotates after `gdprErase` overwrites the password), any outstanding JWT for a deleted user stops working on the next request. See **Delete semantics** for the broader policy.

When adding a new resource that stores user-facing secrets (API keys, tokens, etc.), mirror this pattern: never store in plaintext (hash or encrypt), `@Exclude()` from the response DTO, map per-field uniqueness errors through the global Prisma filter.

### Delete semantics

Soft delete is not a default — each resource picks explicitly based on the rules below. The naive "always soft delete" and "always hard delete" policies both bite eventually: the first leaks data through forgotten `WHERE deletedAt IS NULL` filters; the second destroys audit trails and makes admin mistakes unrecoverable.

**Use hard delete when:**
- The row is transient or operational (push-notification tokens, sessions, OTPs, queue entries, cache warmers).
- A unique constraint matters and keeping soft-deleted rows around would block re-registration (e.g. FCM tokens, email verification codes).
- FK cascades are desired — deleting the parent should clean up children.
- The resource has no retention, audit, or restore value.

**Use soft delete (`deletedAt DateTime?` + `deletedBy String? @db.Uuid`) when:**
- The record is referenced by historical data that needs to remain queryable (users, bookings, orders, payments, reviews).
- Admin mistakes need to be reversible.
- Compliance or legal retention applies (financial records, healthcare).
- You care about "who owned this thing at the time of the event" questions.

**Keep `isActive` and `deletedAt` separate:** see **Business state vs lifecycle** above. Short version — `isActive` is suspension, `deletedAt` is deletion, and not every resource needs both (or either). For soft-delete resources that also have suspension, they're independent flags; the delete paths write `deletedAt` only, never `isActive=false`, so "suspended" and "deleted" don't conflate.

**GDPR / right-to-be-forgotten is a third mode.** Soft delete retains the PII; a genuine erasure request requires overwriting the identifying columns. The `User` model's `gdprErase` method is the canonical pattern: mark `deletedAt`, then set `email`/`firstName`/etc. to sentinel values, null out everything else, rehash the password so no valid credential survives. The row stays (so FK'd audit logs and bookings still point at a valid `id`) but carries nothing identifying.

**When in doubt, the answer is usually soft delete plus a GDPR-erase endpoint.** Booking/social apps especially: a user closing their account is "soft" (grace period, possible restore, preserve booking history); a user invoking their right to be forgotten is "hard" (anonymize).

**Current per-resource policy in this template:**

| Resource | Admin `DELETE /:id` | Self `DELETE /me` | `/me/gdpr-erase` | `isActive`? | Rationale |
|---|---|---|---|---|---|
| `users` | soft (`deletedAt`) | soft (`deletedAt` + `deletedBy`) | anonymize PII + soft delete | yes (suspension) | Retention + recovery; JWT invalidation + login rejection for deletedAt. `isActive` reserved for admin suspension. |
| `app_versions` | hard delete | — | — | no | Release signal table, not a history. Bad release → delete + replace. |
| `device_tokens` | hard delete | — | — | no | Transient; globally-unique `token` means soft delete would block re-registration; FK cascade handles user deletion cleanup. |
| `audit_logs` | (never deleted through API) | — | — | no | Append-only. Retention/archival is a separate concern. |

**When adding a new resource, decide up front and document:** if soft delete, add both `deletedAt DateTime?` and `deletedBy String? @db.Uuid`, update `remove()` to `prisma.update({ deletedAt: new Date(), deletedBy: actorId })`, ensure anywhere the resource drives access control (auth, list filters) checks `deletedAt IS NULL`. If hard delete, leave both columns out of the schema and keep `remove()` at `prisma.<model>.delete`.

**Never rely on "remembered" filters for security.** The template enforces this via a global soft-delete Prisma extension — see next section.

### Soft-delete filter: `prisma.scoped` vs raw `prisma`

`PrismaService` exposes two views on the same connection pool:

- **`this.prisma.user.*`** — *raw*. Sees every row, including soft-deleted. Use in admin/forensic/recovery/retention code paths that explicitly need to look at deleted rows.
- **`this.prisma.scoped.user.*`** — *filtered*. Every read (`findMany`, `findFirst`, `findUnique`, `count`, etc.) automatically injects `deletedAt: null`, so soft-deleted rows are invisible. Use in every user-facing code path.

Mechanism: the Prisma Client Extension at `src/prisma/prisma-soft-delete.extension.ts` intercepts reads on any model in its `SOFT_DELETE_MODELS` set and either injects the `where: { deletedAt: null }` clause (for `findFirst`/`findMany`/`count`) or fetches-then-nullifies (for `findUnique`/`findUniqueOrThrow`, since their `where` type only accepts unique fields). Writes (`create`/`update`/`delete`) pass through on both views so admin flows like restore-a-deleted-user (`update({ data: { deletedAt: null } })`) and hard-delete-for-retention still work.

**Adding a new soft-delete model**: declare `deletedAt DateTime?` + `deletedBy String? @db.Uuid` on the schema (see **Delete semantics**), then add the model name to `SOFT_DELETE_MODELS` in the extension file. That's the only manual step — every call through `prisma.scoped.*` automatically starts filtering.

**Hot-path enforcement**: `AuthService.login` uses `findByEmail`, and `JwtStrategy.validate` uses `findByIdOrNull`; both go through `prisma.scoped`, so soft-deleted users are indistinguishable from unknown users (same 401, same timing via dummy bcrypt). No explicit `if (user.deletedAt)` check survives in the auth path — it would be dead code because the query never returns a deleted user.

**When to reach for the raw client instead**: admin `GET /users/:id` (so admins can recover / re-enable a deleted user), `UsersService.findById` (admin fetch), any retention/archival job that processes soft-deleted rows, forensic queries over the audit log joined with deleted users. `UsersService.findById` in this template already uses the raw client for exactly this reason; `findByIdOrNull` and `findByEmail` both use `scoped`. New services should copy this split.

### Operational posture

- **Structured logging via pino** (`nestjs-pino`). Prod/staging emit JSON one-line-per-event; dev uses `pino-pretty`. Every request gets an `X-Request-Id` header (reused if the client sends one, random UUID otherwise) — included in every log line for trace correlation. Sensitive fields are redacted at source: `authorization`, `cookie`, `req.body.password`, `req.body.newPassword`, `req.body.currentPassword`, `req.body.otp`. When adding new sensitive request bodies, extend the `redact.paths` array in `app.module.ts`.
- **Rate-limiter storage is Redis** (`@nest-lab/throttler-storage-redis`) in dev/staging/prod so multi-pod deployments share one counter — in-memory storage would give each pod its own bucket and effectively multiply the limit by pod count. Test env (`NODE_ENV=test`) stays on in-memory so e2e doesn't require the throttler's Redis-backed counter. Note: the shared `RedisModule` (`src/common/redis/`) that backs the JWT logout blocklist is separate from the throttler's Redis client and **is** exercised in tests — CI provisions a Redis service container alongside Postgres.
- **Password-change notification email** fires automatically from every path that mutates an existing user's password — self-service `/me/password`, admin `PATCH /users/:id/password`, admin `PATCH /users/:id` with a `password` field, and the password-reset OTP flow. Implemented in `UsersService.notifyPasswordChanged` (best-effort — failure is logged but doesn't block the password change). Intentionally **not** fired on initial `create`/`register` (no prior password to worry about) or `gdprErase` (anonymization; the email address is being nullified anyway).
- **Email delivery is abstracted** via `EmailService` in `common/email/`. Provider is selected by `EMAIL_PROVIDER` env var:
  - `stub` (default, dev/test) — logs every send to stdout via `StubEmailAdapter`. OTPs surface in the console so manual flows work without a mail server.
  - `resend` (staging/prod) — routes through [resend.com](https://resend.com) via `ResendEmailAdapter`. Requires `RESEND_API_KEY` + `EMAIL_FROM` (Joi-enforced in `env.validation.ts`). `EMAIL_FROM` must be on a domain verified in the Resend dashboard with DKIM/SPF/DMARC configured — otherwise messages bounce or land in spam.
  - Only the selected adapter's constructor runs at boot, so the Resend adapter's `getOrThrow('email.resendApiKey')` doesn't fire when provider is `stub`. If you wire a third provider (Postmark, SES, etc.), add its adapter under `common/email/adapters/` and extend the factory in `email.module.ts`.
- **Email templates** live in `src/common/email/templates/` as Handlebars files — one file per template: `<name>.html.hbs`. Optionally add `<name>.text.hbs` for a richer plain-text fallback; without it, the engine derives text by stripping HTML. Subjects are defined in the typed `TEMPLATE_SUBJECTS` map in `template-engine.ts` (not as separate files) — either as a static string or a function of the template's variables (`(vars) => \`Welcome, ${vars.firstName}\``). Templates compile at module init, so a typo in a `{{var}}` reference surfaces at startup rather than on the first email send.
  - Call sites use `emailService.sendTemplate('<name>', to, vars)` — fully type-checked. `sendEmailVerificationOtp` / `sendPasswordResetOtp` on `EmailService` are thin wrappers; add more for new flows.
  - **Adding a template** = (1) add the key + var shape to the `EmailTemplates` interface, (2) add the subject to `TEMPLATE_SUBJECTS`, (3) drop `<name>.html.hbs` into `./templates/`. A missing entry in either map is a compile error — the maps use `{ [K in keyof EmailTemplates]: … }` to enforce coverage.
  - `.hbs` files are copied into `dist/` via the `compilerOptions.assets` block in `nest-cli.json`, so templates work in both `yarn start:dev` (ts-node) and the production image.
- **Audit logs**: `AuditService.record({ action, actorId, targetUserId, metadata })` writes to the `audit_logs` table. Already wired into admin create/update/delete, admin password reset (`password.reset.by_admin`), and self password reset (`password.reset.completed`). Extend when adding privileged actions — writes are best-effort (try/catch inside the service) so an audit failure never blocks the business operation.
- **API docs** live at `GET /api/docs` via `@nestjs/swagger`. Bearer auth is pre-configured (`addBearerAuth()`), and the `@nestjs/swagger` compiler plugin is enabled in `nest-cli.json` (`plugins[0].name = "@nestjs/swagger"`) with `classValidatorShim: true` and `introspectComments: true` — meaning DTOs **don't need manual `@ApiProperty()` decorators**. The plugin reads class-validator annotations and TS types at build time and generates the OpenAPI schema automatically: `@IsEmail` → `format: email`, `@IsOptional` → omits field from `required`, `@MaxLength`/`@MinLength` → string bounds, etc. Only reach for explicit `@ApiProperty()` when you want an example value, a description override, or a schema that the plugin can't infer (e.g. polymorphic unions). Controllers should carry `@ApiTags('GroupName')` for UI grouping and `@ApiBearerAuth()` at the class level (or per method) when the route requires a JWT — the UI renders a lock icon accordingly.
- **Extended mapped types for Swagger**: DTOs that inherit via `PartialType` / `PickType` / `OmitType` / `IntersectionType` must import from `@nestjs/swagger` (not `@nestjs/mapped-types`). The Swagger versions are drop-in replacements that preserve class-validator behavior AND propagate schema metadata to derived classes. Without this, inherited DTOs render as empty objects in `/api/docs`.
- **Production env enforcement** via Joi `.when('NODE_ENV', { is: 'production', ... })`: `CORS_ORIGIN` can't be `*`, `TRUST_PROXY` can't be `false` or `true` (force explicit `"1"` or CIDR list). Both fail boot with a pointed error message. Local dev is unaffected.

### Email verification flow (JWT link)

Stateless: no DB row is written when the verification link is issued. The JWT itself carries `{ sub: userId, purpose: 'email_verify' }` and expires in 24h.

1. **Registration** (`POST /auth/register`) creates the user with `emailVerifiedAt = null`, calls `UsersService.sendEmailVerificationLink(user)`, and returns `{ user, message }` — **no access token**. The verification email goes out as part of the request (awaited) so a provider outage surfaces as a 5xx at register time, not a silent "link never arrived."
2. **Link format**: `{APP_BASE_URL}/auth/verify-email?token=<jwt>`. Point `APP_BASE_URL` at your frontend (which extracts the token and POSTs it) or at the API base (which responds to GET directly). Configurable per environment.
3. **Consumption** (`verifyEmailByToken`): `jwtService.verify` on the token, check `purpose === 'email_verify'`, look up user, set `emailVerifiedAt = now`. Idempotent — re-verifying an already-verified user is a 200 no-op.
4. **Login gate**: `AuthService.login` throws `401 { error: 'EmailNotVerified', message: '…' }` after successful password match if `emailVerifiedAt` is null. Wrong-password and unknown-email still return the generic "Invalid credentials" — the specific error only leaks to someone who already knows the password, keeping the enumeration surface narrow.
5. **Resend** (`POST /auth/resend-verification`): public endpoint, takes `{ email }`, strictly throttled (3/min), always returns 200 regardless of whether the email is registered. No enumeration.

**Security cross-checks**:
- `JwtStrategy` rejects any token with a `purpose` claim set, so a stolen verification link can't be used as an access token — access tokens never carry `purpose`.
- The verification JWT is signed with the same `JWT_SECRET` as access tokens but bound by its `purpose` claim; no separate signing key is needed.
- `resendEmailVerification` is a silent no-op for soft-deleted or already-verified users, so the endpoint never reveals account state.

### OTP lifecycle (password reset only)

Single `otpHash`/`otpPurpose`/`otpExpiresAt` triple per user — one active OTP at a time per account. **Used only for password reset** since email verification switched to a JWT link (see above).

1. **Issuance** (`requestPasswordReset`): generate a 6-digit code, `bcrypt.hash` into `otpHash`, set `otpPurpose = 'password_reset'`, `otpExpiresAt = now + 15m`, send raw code via `EmailService`.
2. **Consumption** (`resetPassword`): verify purpose + expiry match, `bcrypt.compare` the code, apply the effect (hash the new password), then null out all three OTP fields.

Attacker considerations baked in: (a) `requestPasswordReset` returns 200 even if the email doesn't exist — no enumeration; (b) `resetPassword` returns the same opaque "Invalid or expired reset code" for every failure mode; (c) the `/request-password-reset` endpoint carries a strict per-IP throttle; (d) `otpPurpose` is still checked so the field isn't generically misusable.

If you add another OTP-style flow (SMS verification, step-up auth), add a new purpose to `OtpPurpose` enum, issue/consume via dedicated endpoints — don't overload existing ones.

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

- **`global-setup.ts`** — runs once before the test suite. Loads `.env.test`, connects to the `postgres` admin DB on the same Postgres container, **terminates any lingering connections**, **drops and re-creates** `${SERVICE_NAME}_test` (e.g. `nestjs_test`), then runs `prisma migrate deploy` against the fresh DB. So **every `yarn test:e2e` invocation starts from zero** — guaranteed schema parity with the migration history, no stale state from a previous run, and an implicit "do migrations work from empty?" gate on every run.
- **`load-env.ts`** — runs at the start of each test process (Jest `setupFiles`). Loads `.env.test` with `dotenv` + `dotenv-expand`. Uses `override: false` (dotenv default) so CI's `env:` block always wins.
- **`test-app.ts`** — `createTestApp()` boots the full `AppModule` and applies the same global setup as `main.ts` (helmet, prefix `/api`). All other globals (ValidationPipe, ClassSerializerInterceptor, AllExceptionsFilter) are wired via `APP_*` providers and therefore apply automatically. Tests should call `createTestApp()` in `beforeAll`, not import individual modules — the goal is parity with prod.
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
5. To seed an `ADMIN`, write directly via `app.get(PrismaService).user.create({ ... role: 'admin' })` then log in via `POST /api/auth/login` to get a token (the `register` endpoint always creates role `'user'` — see `RegisterDto`). Role values are lowercase — the TS enum `Role.ADMIN = 'admin'` is the source of truth.

### CI

`.github/workflows/ci.yml` has two jobs:

1. **`ci`** — lint → build → unit tests → e2e tests → `yarn audit` (moderate severity, non-blocking warning). Postgres 18.3 provisioned as a service container; env vars set inline (`.env.test` is silently ignored).
2. **`docker`** — depends on `ci` passing. Builds the production image via `docker/build-push-action`, then scans with Trivy for HIGH/CRITICAL CVEs (non-fixed issues are ignored to keep the build reliable). The image isn't pushed — wire a registry when you have one.

Redis is provisioned in CI as a service container because `/auth/logout` writes to the shared Redis blocklist during e2e tests. The throttler's internal Redis client remains disabled in test env via `skipIf`, but the app-level `RedisService` (`src/common/redis/`) is exercised regardless.

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
- **`PrismaService`** has a constructor that injects `ConfigService`, builds a `PrismaPg({ connectionString })` adapter, and passes it to `super({ adapter })`. The `extends PrismaClient` pattern still holds; the only change vs. Prisma 6 is the constructor.

The `pg` package is a **runtime dependency** (the adapter wraps a `pg.Pool`), not just a test devDep. Bumping the adapter or `pg` should be done together to avoid version skew.
