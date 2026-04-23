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
    enums/             # Role, Gender, OtpPurpose — TS-only enums (no DB enums — see "Generating a new resource")
  modules/
    auth/              # AuthService, AuthController, JwtStrategy, JwtAuthGuard, login/register DTOs (per-route stricter throttle)
    users/             # UsersService, controller, DTOs (Create/Update/Response) — canonical resource pattern
    health/            # @nestjs/terminus: GET /health/liveness (memory) + GET /health/readiness (DB ping via PrismaHealthIndicator)
prisma/schema.prisma   # PostgreSQL datasource; User model
```

Endpoints (all under `/api`):
- **Auth** — `POST /auth/register`, `POST /auth/login`, `GET /auth/me` (JwtAuthGuard). Login + register override the global throttle with stricter per-route limits (10/min and 5/min) to slow brute-force attempts.
- **Users** — the class has `@UseGuards(JwtAuthGuard, RolesGuard)`; each handler declares its own `@Roles(...)` (or `@Public()` for `sign-up`). Split:
  - **Public**: `POST /users/sign-up` — delegates to `AuthService.register`; returns `{ accessToken, user }`.
  - **Self-service** (any authenticated user; no `@Roles`): `GET /users/me`, `PATCH /users/me` (profile fields only), `DELETE /users/me` (soft delete — flips `isActive`), `PATCH /users/me/username`, `PATCH /users/me/email` (requires `currentPassword`; resets `emailVerifiedAt`), `PATCH /users/me/password` (requires `currentPassword`), `PATCH /users/me/profile-image`, `POST /users/verify-email` (consumes OTP — issuance endpoint is a TODO).
  - **Admin** (`@Roles(Role.ADMIN)`): `POST /users`, `GET /users` (paginated, `?page=1&perPage=20`, max 100), `GET /users/all`, `GET /users/:id`, `PATCH /users/:id`, `PATCH /users/:id/password` (no current-password check), `DELETE /users/:id` (hard delete, 204).
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
  isActive        Boolean   @default(true)
  // resource-specific fields below this line
  @@map("orders")
}
```

The `User` model additionally carries auth-specific columns (`passwordChangedAt`, `failedLoginCount`, `lockedUntil`) — see **Security model** below.

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
- **DELETE returns 204** via `@HttpCode(HttpStatus.NO_CONTENT)`. For soft delete, the endpoint stays `DELETE` and the service flips `isActive` instead of calling `prisma.<model>.delete`.
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
- `remove(id)` — hard delete via `prisma.<model>.delete` after existence check. For soft delete, `update({ isActive: false })` instead and document it.
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
- **Admin self-target on `PATCH /users/:id/password` is refused**: `UsersService.updatePasswordAsAdmin` throws 403 when `userId === actorId`. Admins must use `/me/password` (which requires the current password) to change their own — blocks session-hijack → permanent account takeover.
- **Account lockout on failed logins**: 5 failed attempts → `lockedUntil = now + 15m`; successful login clears the counter. Tracked in `User.failedLoginCount` + `User.lockedUntil`. Combined with the per-IP throttle (10/min on `/auth/login`), distributed brute force is constrained.
- **Login timing normalized**: when the email isn't registered, `AuthService.login` still runs a bcrypt compare against a lazy-computed dummy hash so wall-clock time doesn't distinguish "unknown user" from "wrong password". Closes the email enumeration vector.
- **bcrypt cost = 12** (`users.service.ts:BCRYPT_ROUNDS`). OWASP 2024 guidance.
- **Password policy**: `@MinLength(12)` + `@MaxLength(72)` (bcrypt truncation guard) + regex requiring at least one letter and one digit. Applied on create/sign-up and every "new password" field (not `currentPassword` fields, which must accept legacy values for re-auth).
- **Sign-up rate-limited**: `@Throttle({ limit: 5, ttl: 60_000 })` on `POST /users/sign-up` (same as `/auth/register`). Prevents mass-account creation per IP.
- **`@Public()` decorator**: `src/common/decorators/public.decorator.ts` + handled in `JwtAuthGuard`. Use sparingly — currently only `sign-up`. Any public endpoint that accepts user-controlled input needs its own `@Throttle(...)` too; the global 100/min is too loose for public endpoints.
- **Generic 500 responses**: `AllExceptionsFilter` returns `"Internal server error"` for non-`HttpException` errors; the real message is logged server-side. Prevents leaking Prisma/Node internals (hostnames, file paths) to clients.
- **Password, OTP hash, `passwordChangedAt`, `failedLoginCount`, `lockedUntil`** are all `@Exclude()`-marked in `UserResponseDto`. Never build a response that serializes these directly — always go through the DTO.

When adding a new resource that stores user-facing secrets (API keys, tokens, etc.), mirror this pattern: never store in plaintext (hash or encrypt), `@Exclude()` from the response DTO, map per-field uniqueness errors through the global Prisma filter.

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
- **`PrismaService`** has a constructor that injects `ConfigService`, builds a `PrismaPg({ connectionString })` adapter, and passes it to `super({ adapter })`. The `extends PrismaClient` pattern still holds; the only change vs. Prisma 6 is the constructor.

The `pg` package is a **runtime dependency** (the adapter wraps a `pg.Pool`), not just a test devDep. Bumping the adapter or `pg` should be done together to avoid version skew.
