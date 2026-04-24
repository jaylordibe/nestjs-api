# CLAUDE.md

Guidance for Claude Code working in this repo.

## Project

NestJS 11 (TypeScript, Express) + Prisma 7 + PostgreSQL + Redis. JWT auth with RBAC (`ADMIN`, `USER`). GitHub template: set `SERVICE_NAME` in `.env`, add feature modules. URLs unversioned (`/api/...`).

Package manager: **yarn** (yarn.lock committed). Scripts: `start:dev`, `start:prod`, `build`, `lint`, `format`, `test`, `test:e2e`, `prisma:generate`, `prisma:migrate`, `prisma:deploy`, `prisma:seed`, `prisma:studio`. `docker compose up -d` brings up pinned Postgres 18.3 + Redis 8.6.2 (host ports **5433** / **6378**).

## Architecture

```
src/
  main.ts              # bootstrap: helmet, prefix /api, trust proxy, CORS, shutdown hooks
  app.module.ts        # ConfigModule + ThrottlerModule + PrismaModule + feature modules;
                       # registers APP_PIPE (ValidationPipe), APP_INTERCEPTOR (ClassSerializerInterceptor),
                       # APP_FILTER (AllExceptionsFilter then PrismaExceptionFilter — LIFO), APP_GUARD (ThrottlerGuard)
  config/              # configuration.ts (typed factory), env.validation.ts (Joi)
  prisma/              # @Global() PrismaModule + PrismaService + soft-delete extension
  common/
    decorators/        # Roles, CurrentUser (+ AuthenticatedUser type), Public
    guards/            # RolesGuard (reads ROLES_KEY metadata)
    filters/           # AllExceptionsFilter + PrismaExceptionFilter (P2002→409, P2025→404)
    dto/               # PaginationQueryDto, PaginatedResponseDto<T>, PaginationMeta
    enums/             # Role, Gender, OtpPurpose, AppPlatform, DeviceType, DeviceOs
    email/             # EmailService (@Global), adapters (stub/resend), Handlebars templates
    audit/             # AuditService (@Global) — best-effort audit_logs writes
    redis/             # RedisService (@Global) — ioredis client (JWT logout blocklist)
  modules/
    auth/              # AuthService, AuthController, JwtStrategy, JwtAuthGuard
    users/             # canonical resource pattern
    health/            # terminus: /health/liveness + /health/readiness
prisma/schema.prisma   # PostgreSQL datasource
```

All endpoints under `/api`. See Swagger at `/api/docs`.

## Generating a new resource

Every new resource follows the users pattern exactly.

### Required schema columns (physical order)

```prisma
model Order {
  id         String    @id @default(uuid()) @db.Uuid
  createdAt  DateTime  @default(now())
  updatedAt  DateTime  @updatedAt
  createdBy  String?   @db.Uuid
  updatedBy  String?   @db.Uuid
  deletedAt  DateTime? // only for soft-delete resources
  deletedBy  String?   @db.Uuid // pairs with deletedAt
  isActive   Boolean   @default(true) // only when resource has distinct suspension state
  // resource-specific fields below
  @@map("orders")
}
```

**Always required**: `id`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy`. Order groups at/by pairs, then lifecycle, then state.

**Opt-in pairwise**:
- `deletedAt` + `deletedBy` — add when using soft delete. `deletedBy` survives restore-re-delete cycles.
- `isActive` — only when there's a real suspension concept distinct from deletion. Don't add reflexively.

### Business state vs lifecycle

`isActive` = **suspension** (business state). `deletedAt` = **deletion** (lifecycle). Keep separate. For `User`: soft-delete and gdpr-erase never touch `isActive`; auth rejects on any of soft-deleted, `!isActive`, or `lockedUntil > now` (three independent reasons, none conflated).

### No DB enums

Enum-like columns stored as `String`. Constrain via TS enum in `src/common/enums/` + `@IsEnum()` on DTO. Changing a TS enum doesn't require a migration.

**Style**: UPPER_SNAKE keys, lowercase_snake string values. DB stores lowercase; TS uses enum. Cast at DB→app boundary: `user.role as Role`.

### Module layout

```
src/modules/<resource>/
  dto/
    create-<resource>.dto.ts     # class-validator; no audit/system fields
    update-<resource>.dto.ts     # extends PartialType(Create<Resource>Dto)
    <resource>-response.dto.ts   # @Exclude() sensitive cols
  <resource>.module.ts
  <resource>.service.ts
  <resource>.controller.ts
```

Register in `app.module.ts` imports. `PrismaModule` is `@Global()`.

### Standard endpoints (always these six, in this order)

| Verb   | Path                | Method          | Returns                                       |
|--------|---------------------|-----------------|-----------------------------------------------|
| POST   | `/<resource>`       | `create`        | `<Resource>ResponseDto`                       |
| GET    | `/<resource>`       | `findPaginated` | `PaginatedResponseDto<<Resource>ResponseDto>` |
| GET    | `/<resource>/all`   | `findAll`       | `<Resource>ResponseDto[]`                     |
| GET    | `/<resource>/:id`   | `findOne`       | `<Resource>ResponseDto`                       |
| PATCH  | `/<resource>/:id`   | `update`        | `<Resource>ResponseDto`                       |
| DELETE | `/<resource>/:id`   | `remove`        | `void` (204)                                  |

Rules:
- **Declaration order matters** — `@Get('all')` (and any static path) must appear before `@Get(':id')`, else captured by UUID param → 400 via `ParseUUIDPipe`.
- **Pagination** uses `PaginationQueryDto`. Defaults `page=1`, `perPage=20`, max `perPage=100`. Meta: `{ page, perPage, total, totalPages }`.
- **`/all` unpaginated** — for dropdowns/exports under a few thousand rows.
- **PATCH not PUT.** `Update<Resource>Dto = PartialType(Create<Resource>Dto)`.
- **DELETE returns 204** via `@HttpCode(HttpStatus.NO_CONTENT)`.
- **UUID params** use `@Param('id', new ParseUUIDPipe())`.

### Controller skeleton

```ts
@Controller('orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  async create(@Body() dto: CreateOrderDto, @CurrentUser() current: AuthenticatedUser) {
    return new OrderResponseDto(await this.ordersService.create(dto, current.id));
  }

  @Get()
  async findPaginated(@Query() query: PaginationQueryDto) {
    const { data, meta } = await this.ordersService.findPaginated(query);
    return { data: data.map((r) => new OrderResponseDto(r)), meta };
  }

  // Must be before @Get(':id').
  @Get('all')
  async findAll() {
    const rows = await this.ordersService.findAll();
    return rows.map((r) => new OrderResponseDto(r));
  }

  @Get(':id')
  async findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return new OrderResponseDto(await this.ordersService.findById(id));
  }

  @Patch(':id')
  async update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateOrderDto, @CurrentUser() current: AuthenticatedUser) {
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
- `findAll()` — `orderBy: { createdAt: 'desc' }`, no pagination/filters.
- `findPaginated(query)` — `findMany` + `count()` in **one** `prisma.$transaction([...])` so total matches page.
- `findById(id)` — throws `NotFoundException`. Pair with `findByIdOrNull(id)` (JwtStrategy needs non-throwing → 401 not 404).
- `update(id, dto, actorId)` — set `updatedBy`, don't touch `createdBy`. Re-check existence for 404 not P2025.
- `remove(id, actorId)` — hard `delete` for transient; `update({ deletedAt: new Date(), deletedBy: actorId })` for retention. See **Delete semantics**.
- **Don't try/catch Prisma errors.** Global `PrismaExceptionFilter` maps P2002→409 (field-aware message via `err.meta.target`), P2025→404, else 500.

### Audit fields

`createdBy`/`updatedBy` do **not** auto-populate — every mutating method takes `actorId: string | null` and writes it. Controllers pass `@CurrentUser().id`. For unauthenticated creates pass `null`. Deliberate explicit-arg pattern — actor visible at every callsite.

### Response DTO

Always construct via `new <Resource>ResponseDto(row)`. Never return raw Prisma rows — secrets leak.

**Audit columns are hidden from frontend.** Only `createdAt`/`updatedAt` exposed. `createdBy`, `updatedBy`, `deletedAt`, `deletedBy` kept in DB but stripped from API. **Pair `@ApiHideProperty()` with `@Exclude()`** — independent systems (Swagger build-time vs class-transformer runtime). Both needed to keep docs + wire in sync.

```ts
export class OrderResponseDto {
  id!: string;
  createdAt!: Date;
  updatedAt!: Date;
  @ApiHideProperty() @Exclude() createdBy!: string | null;
  @ApiHideProperty() @Exclude() updatedBy!: string | null;
  @ApiHideProperty() @Exclude() deletedAt!: Date | null; // only if soft-delete
  @ApiHideProperty() @Exclude() deletedBy!: string | null;
  isActive!: boolean; // only if resource has suspension
  @ApiHideProperty() @Exclude() secretColumn!: string | null;
  constructor(row: Order) { Object.assign(this, row); }
}
```

**E2E tests**: assertions on audit columns must read DB directly (`app.get(PrismaService).<model>.findUniqueOrThrow(...)`), not API body.

### Migration

`yarn prisma:migrate dev --name add_<resource>`. **Until any deployed env has applied migrations, edit migration files in place freely.** After first real deploy, Prisma records checksums in `_prisma_migrations` and drift-errors on changes — only add new migrations from then on.

### E2E test

Required for every resource. Min coverage: six endpoints + access control (401 unauthenticated, 403 wrong role) + pagination (meta shape, invalid params → 400).

## Cross-cutting conventions

- **Security headers**: `helmet()` in `main.ts`.
- **Rate limiting**: `@nestjs/throttler` global `APP_GUARD`, Redis storage in dev/staging/prod (in-memory in test). Default 100/60s/IP. Per-route: `@Throttle({ default: { limit, ttl } })`. Disable: `@SkipThrottle()` (used on `/health/*`).
- **Trust proxy**: `TRUST_PROXY` env, default `"false"`. Behind proxy set to `"1"` or CIDR list. **Never `"true"` in prod** (spoofable `X-Forwarded-For`). Joi rejects `"false"`/`"true"` in production.
- **Validation**: global `ValidationPipe({ whitelist, forbidNonWhitelisted, transform, transformOptions: { enableImplicitConversion: true } })`. Extra fields → 400. Query numbers auto-convert.
- **Response serialization**: global `ClassSerializerInterceptor`. Return DTO instances. Never raw rows.
- **`@Exclude()` vs `@ApiHideProperty()`**: separate layers. Sensitive response fields need **both**.
- **Auth payload**: JWT carries `{ sub, email, role }`. `JwtStrategy.validate` re-fetches via `UsersService.findByIdOrNull` (non-throwing → 401 not 404), checks `isActive`, returns `AuthenticatedUser`. `@CurrentUser()` returns this, NOT a full `User`.
- **RBAC**: `@UseGuards(JwtAuthGuard, RolesGuard)` at class, `@Roles(Role.ADMIN)` on handlers (or omit for any authenticated user). `RolesGuard` is no-op without `@Roles()`. Mixed public/private: use `@Public()` on public handlers.
- **Cross-module forward refs**: when cycles exist (UsersController → AuthService, AuthModule → UsersModule), use `forwardRef` in both imports and `@Inject`.
- **Prisma access**: through `PrismaService` (DI). `@Global()`.
- **Prisma errors**: global `PrismaExceptionFilter` handles P2002/P2025. Services don't try/catch these. `APP_FILTER` is LIFO — register specific filters *after* `AllExceptionsFilter`.
- **Config access**: `configService.getOrThrow<T>('jwt.secret')` etc. Dot-paths into `configuration.ts`. Don't read `process.env` outside that file.
- **`SERVICE_NAME`** is single source of truth. Drives `DB_NAME` default (`${SERVICE_NAME}_local`), container name, JWT `iss`/`aud`.

## Security model

Deliberate hardening decisions — know these before relaxing:

- **`JWT_SECRET`** Joi `.min(32).required().invalid(...)` — rejects the ex-template-default at boot. Regenerate: `openssl rand -hex 48`.
- **`JWT_EXPIRES_IN` = 30d** — consumer-app default. Security relies on `passwordChangedAt` invalidation, not short expiry. For banking/admin: drop to `1h` + add refresh flow.
- **JWT `iss`/`aud`** bound to `SERVICE_NAME` on sign AND verify. Tokens can't be replayed across services.
- **Token invalidation on password change**: `User.passwordChangedAt` written on create + every password update. `JwtStrategy` rejects tokens with `iat` strictly earlier than `passwordChangedAt` (sub-second tolerance prevents false-reject on freshly-issued).
- **Per-token revocation (logout)**: JWT carries `jti`. `POST /auth/logout` writes `logout:jti:<jti>` to Redis with TTL = token remaining lifetime (auto-expires). `JwtStrategy` does `EXISTS` per request. **Fail-open on Redis outage** — warning logged, request allowed. For forced session kill during incident, use `logout-all` (Postgres-backed).
- **Session-wide revocation (logout-all)**: `POST /auth/logout-all` bumps `passwordChangedAt` → existing `iat` check kills all outstanding tokens. Postgres-only, unaffected by Redis.
- **Admin self-target refused** on `PATCH /users/:id/password` — throws 403 when `userId === actorId`. Admins must use `/me/password` (requires current password) — blocks hijack → takeover.
- **Lockout**: 5 failed logins → `lockedUntil = now + 15m`. Successful login clears.
- **Login timing normalized**: unknown email still runs bcrypt compare against dummy hash — no enumeration via wall-clock.
- **bcrypt cost = 12**. `@MinLength(12)` + `@MaxLength(72)` (bcrypt truncation guard) + regex (letter + digit) on every new-password field (not `currentPassword`).
- **`@Public()`**: use sparingly. Any public endpoint with user input needs its own `@Throttle(...)`.
- **Generic 500**: `AllExceptionsFilter` returns `"Internal server error"` for non-`HttpException`; real message logged server-side.
- **Response DTO `@Exclude()`**: password, otpHash, passwordChangedAt, failedLoginCount, lockedUntil on `UserResponseDto`. Never bypass the DTO.
- **Soft-deleted blocked from auth**: `AuthService.login` and `JwtStrategy.validate` both go through `prisma.scoped` — soft-deleted users indistinguishable from unknown (same 401, same timing via dummy bcrypt).

New resources with user-facing secrets (API keys, tokens): never plaintext, `@Exclude()` from DTO, unique errors via global filter.

## Delete semantics

Soft delete is not default — pick explicitly per resource.

**Hard delete when**: row is transient/operational (push tokens, sessions, OTPs); unique constraint would block re-registration; FK cascades desired; no retention/audit value.

**Soft delete (`deletedAt` + `deletedBy`) when**: referenced by historical data (users, bookings, orders, payments); admin mistakes need reversibility; compliance retention applies; care about "who owned this at event time."

**GDPR erase is a third mode** — soft-delete retains PII; real erasure overwrites identifying cols. `User.gdprErase` is canonical: mark `deletedAt`, nullify PII, rehash password so no valid credential survives. Row stays (FK'd audit_logs/bookings remain valid) but carries nothing identifying.

**Current policy:**

| Resource | Admin delete | Self delete | gdpr-erase | isActive? | Why |
|---|---|---|---|---|---|
| `users` | soft | soft | anonymize + soft | yes (suspension) | Retention + recovery; `isActive` reserved for admin suspension |
| `app_versions` | hard | — | — | no | Release signal, not history |
| `device_tokens` | hard | — | — | no | Transient; unique `token` would block re-reg; FK cascade handles user delete |
| `audit_logs` | never via API | — | — | no | Append-only |

**New resource**: decide up front. Soft → add both columns, `remove()` does `update({ deletedAt, deletedBy })`, access-control paths filter `deletedAt IS NULL`. Hard → leave cols out, `remove()` does `prisma.<model>.delete`.

**Never rely on "remembered" filters for security** — enforced via global Prisma extension (next section).

## Soft-delete filter: `prisma.scoped` vs raw `prisma`

`PrismaService` exposes two views on same pool:

- **`this.prisma.user.*`** — raw, sees everything including soft-deleted. Admin/forensic/recovery code paths.
- **`this.prisma.scoped.user.*`** — filtered, auto-injects `deletedAt: null`. Every user-facing code path.

Mechanism: extension in `src/prisma/prisma-soft-delete.extension.ts` intercepts reads on any model in `SOFT_DELETE_MODELS` — injects `where: { deletedAt: null }` for `findFirst`/`findMany`/`count`; fetches-then-nullifies for `findUnique`/`findUniqueOrThrow` (unique where-type limitation). Writes pass through on both views (so admin restore via `update({ deletedAt: null })` still works).

**Adding a soft-delete model**: declare `deletedAt` + `deletedBy`, add model name to `SOFT_DELETE_MODELS`. That's it.

**Hot-path enforcement**: `AuthService.login` + `JwtStrategy.validate` use `prisma.scoped`. No explicit `if (user.deletedAt)` check in auth path — dead code since query never returns deleted.

**When to use raw**: admin `GET /users/:id` (recovery), `UsersService.findById` (admin fetch), retention jobs, forensic joins. `findByIdOrNull` and `findByEmail` use `scoped`.

## Operational posture

- **Logging**: pino (`nestjs-pino`). JSON in prod/staging, pretty in dev. `X-Request-Id` on every request (reused if client-sent, else UUID). Redacted: `authorization`, `cookie`, `req.body.password`, `req.body.newPassword`, `req.body.currentPassword`, `req.body.otp`. Extend `redact.paths` in `app.module.ts` for new sensitive bodies.
- **Rate-limiter storage**: Redis in dev/staging/prod (shared counters across pods). In-memory in test.
- **Password-change notification email** fires from every password-mutating path (`/me/password`, admin `/users/:id/password`, admin `PATCH /users/:id` with password, password-reset OTP). Not fired on initial create or `gdprErase`. Best-effort (logs failure, doesn't block).
- **Email**: `EmailService` abstraction. `EMAIL_PROVIDER`: `stub` (default, logs to stdout) or `resend` (requires `RESEND_API_KEY` + `EMAIL_FROM` on DKIM/SPF/DMARC-configured domain). Only selected adapter's constructor runs at boot.
- **Email templates**: `src/common/email/templates/<name>.html.hbs` (+ optional `.text.hbs`). Subjects in typed `TEMPLATE_SUBJECTS` map in `template-engine.ts` (static or `(vars) => ...`). Templates compile at init — typo in `{{var}}` surfaces at startup. Call via `emailService.sendTemplate('<name>', to, vars)` (type-checked). **Adding a template**: (1) add key + var shape to `EmailTemplates`, (2) add subject to `TEMPLATE_SUBJECTS`, (3) drop file in `./templates/`. Missing map entry = compile error. `.hbs` copied into `dist/` via `nest-cli.json` assets.
- **Audit logs**: `AuditService.record({ action, actorId, targetUserId, metadata })`. Wired into admin create/update/delete, admin password reset, self password reset. Best-effort (try/catch in service).
- **API docs**: `/api/docs` via `@nestjs/swagger`. Compiler plugin enabled (`classValidatorShim: true`, `introspectComments: true`) — DTOs **don't need manual `@ApiProperty()`**. Reach for explicit decorators only for examples/overrides/polymorphic unions. Use `@ApiTags('Group')` for UI grouping, `@ApiBearerAuth()` for JWT routes.
- **Extended mapped types for Swagger**: `PartialType` / `PickType` / `OmitType` / `IntersectionType` must import from `@nestjs/swagger` (not `@nestjs/mapped-types`) — otherwise inherited DTOs render empty in `/api/docs`.
- **Production env enforcement** via Joi `.when('NODE_ENV', { is: 'production', ... })`: `CORS_ORIGIN` can't be `*`; `TRUST_PROXY` can't be `false`/`true` (force `"1"` or CIDR). Fails boot with pointed message.

## Email verification flow (JWT link, stateless)

1. `POST /auth/register` creates user with `emailVerifiedAt = null`, awaits `sendEmailVerificationLink`, returns `{ user, message }` — **no access token**. Provider outage surfaces as 5xx at register time.
2. Link format: `{APP_BASE_URL}/auth/verify-email?token=<jwt>`. JWT carries `{ sub: userId, purpose: 'email_verify' }`, 24h expiry.
3. Consumption: `jwtService.verify`, check `purpose === 'email_verify'`, set `emailVerifiedAt = now`. Idempotent (re-verify = 200 no-op).
4. Login gate: `AuthService.login` throws `401 { error: 'EmailNotVerified' }` after successful password match if unverified. Wrong-password still generic "Invalid credentials" — specific error only leaks to someone who knows the password.
5. `POST /auth/resend-verification`: public, throttled 3/min, always 200. No enumeration.

**Cross-checks**:
- `JwtStrategy` rejects any token with `purpose` claim — stolen verification link can't be access token.
- Verification JWT uses same `JWT_SECRET` but bound by `purpose` claim.
- `resendEmailVerification` is silent no-op for soft-deleted/already-verified users.

## OTP lifecycle (password reset only)

Single `otpHash`/`otpPurpose`/`otpExpiresAt` triple per user.

1. `requestPasswordReset`: 6-digit code → `bcrypt.hash` → `otpHash`. `otpPurpose = 'password_reset'`, `otpExpiresAt = now + 15m`. Raw code via email.
2. `resetPassword`: verify purpose + expiry, `bcrypt.compare`, apply (hash new password), null all three OTP fields.

Attacker guards: (a) `requestPasswordReset` always 200; (b) `resetPassword` opaque "Invalid or expired" for every failure; (c) strict per-IP throttle; (d) `otpPurpose` check.

New OTP flow: add purpose to `OtpPurpose` enum, dedicated endpoints — don't overload.

## TypeScript gotchas

- **Decorator + `isolatedModules`**: types in decorated signatures must use `import type` (or separate type-only line). Value + type in one statement → TS1272.
  ```ts
  import { CurrentUser } from '../../common/decorators/current-user.decorator';
  import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
  ```
- **`@nestjs/jwt` `expiresIn`**: typed `number | StringValue`. Runtime `string` from ConfigService needs `as unknown as number` cast (see `auth.module.ts`).

## Testing

**E2E** (`test/*.e2e-spec.ts`) run against real Postgres test DB — no mocks.

Harness in `test/setup/`:
- `global-setup.ts` — once before suite: loads `.env.test`, connects to `postgres` admin DB, terminates connections, **drops + recreates** `${SERVICE_NAME}_test`, runs `prisma migrate deploy`. Every `yarn test:e2e` starts from zero.
- `load-env.ts` — Jest `setupFiles`: `.env.test` via dotenv + dotenv-expand, `override: false` (CI env wins).
- `test-app.ts` — `createTestApp()` boots full `AppModule` + applies same globals as `main.ts` (helmet, `/api` prefix). Other globals via `APP_*` providers apply automatically.
- `db.ts` — `truncateAll(app)` runs `TRUNCATE ... RESTART IDENTITY CASCADE` on every public table (skips `_prisma_migrations`). Call in `beforeEach`.

`.env.test` committed. Throttler disabled in test env via `skipIf`.

**Adding e2e spec**:
1. `beforeAll: app = await createTestApp()`, `afterAll: await app.close()`.
2. `beforeEach: await truncateAll(app)`.
3. `request(app.getHttpServer()).post('/api/...').send(...).expect(...)`.
4. Seed admin via `PrismaService.user.create({ role: 'admin' })` (register always creates `user` role). Values lowercase — `Role.ADMIN = 'admin'`.

## Lint/format

ESLint uses typescript-eslint **recommendedTypeChecked** (type-aware, slow on large diffs). Overrides in `eslint.config.mjs`:
- `@typescript-eslint/no-explicit-any` — off
- `@typescript-eslint/no-floating-promises` — warn
- `@typescript-eslint/no-unsafe-argument` — warn
- Prettier as ESLint rule, `endOfLine: "auto"`

Recurring rules:
- `no-unsafe-enum-comparison` on enum-to-numeric: cast `(status as number) >= 500`.
- `no-unsafe-member-access` on supertest `res.body` (is `any`): narrow `const body = res.body as { ... };`.

## Prisma 7

Uses `@prisma/adapter-pg` (required in Prisma 7).

- **`prisma/schema.prisma`**: `provider = "postgresql"` only, no `url`.
- **`prisma.config.ts`**: loads `.env` with dotenv-expand, exposes `{ schema, migrations.path, datasource.url }`. Prisma CLI auto-discovers.
- **`PrismaService`**: constructor injects `ConfigService`, builds `PrismaPg({ connectionString })`, passes to `super({ adapter })`.

`pg` is a **runtime** dependency (not just test). Bump adapter + `pg` together.
