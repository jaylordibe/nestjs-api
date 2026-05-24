---
name: nestjs-new-resource
description: Use when adding or scaffolding a new CRUD resource/module (controller + service + DTOs + Prisma model + migration + e2e) following the canonical users pattern. Covers required schema columns, the standard endpoints, list queries (sort/search/filters), actor-scoped lists, audit fields, response DTOs with relation includes, delete semantics (hard vs soft vs gdpr), and the prisma.scoped vs raw soft-delete filter.
---

# New resource (canonical pattern)

Every new resource follows the **users** pattern exactly. Copy-paste code skeletons live in `docs/resource-pattern.md` — this skill holds the rules and rationale; refer to that file for the literal code.

## Required schema columns (physical order)

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
- `deletedAt` + `deletedBy` — for soft delete. `deletedBy` survives restore-re-delete cycles.
- `isActive` — only when there's a real suspension concept distinct from deletion. Don't add reflexively.

### Business state vs lifecycle

`isActive` = **suspension** (business state). `deletedAt` = **deletion** (lifecycle). Keep separate. For `User`: soft-delete and gdpr-erase never touch `isActive`; auth rejects on any of soft-deleted, `!isActive`, or `lockedUntil > now` (three independent reasons, none conflated).

### No DB enums

Enum-like columns stored as `String`. Constrain via TS enum in `src/common/enums/` + `@IsEnum()` on DTO. Changing a TS enum doesn't require a migration.

**Style**: UPPER_SNAKE keys, lowercase_snake string values. DB stores lowercase; TS uses enum. Cast at DB→app boundary: `user.role as Role`.

## Module layout

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

## Standard endpoints (always these five, in this order)

| Verb   | Path                | Method          | Returns                                       |
|--------|---------------------|-----------------|-----------------------------------------------|
| POST   | `/<resource>`       | `create`        | `<Resource>ResponseDto`                       |
| GET    | `/<resource>`       | `findPaginated` | `PaginatedResponseDto<<Resource>ResponseDto>` |
| GET    | `/<resource>/:id`   | `findOne`       | `<Resource>ResponseDto`                       |
| PATCH  | `/<resource>/:id`   | `update`        | `<Resource>ResponseDto`                       |
| DELETE | `/<resource>/:id`   | `remove`        | `void` (204)                                  |

Rules:
- **No unpaginated `GET /all` / `findAll`.** Full-table reads OOM/crash the system once a table grows — there is no "fetch everything" endpoint. Always paginate via `GET /` (`findPaginated`); for dropdowns, page through it or add a narrow filtered query.
- **Declaration order matters** — any static path (e.g. a `@Get('latest')`) must appear before `@Get(':id')`, else it's captured by the UUID param → 400 via `ParseUUIDPipe`.
- **List queries** use `MetaQueryDto` (`page`, `perPage`, `search`, `sortBy`, `sortOrder`). `page` defaults to 1, `perPage` to 20 (max 100) — defaults are class-field initializers so service code reads `query.page` directly without `?? 1`. Meta: `{ page, perPage, total, totalPages }`.
- **PATCH not PUT.** `Update<Resource>Dto = PartialType(Create<Resource>Dto)` (import `PartialType` from `@nestjs/swagger`).
- **DELETE returns 204** via `@HttpCode(HttpStatus.NO_CONTENT)`.
- **UUID params** use `@Param('id', new ParseUUIDPipe())`.

Controller + service skeletons: `docs/resource-pattern.md`.

## Service skeleton

- `create(dto, actorId)` — set `createdBy: actorId, updatedBy: actorId`.
- `findPaginated(query)` — `findMany` + `count()` in **one** `prisma.$transaction([...])` so total matches page. Same `where` on both calls.
- **`findPaginated` builds its query via a private `buildListArgs(query)`** that calls `buildOrderBy(query, [...] as const, 'createdAt')`. Single source of truth for the sort allowlist + any future search clause.
- `findById(id)` — throws `Errors.resourceNotFound(...)`. Pair with `findByIdOrNull(id)` (JwtStrategy needs non-throwing → 401 not 404).
- `update(id, dto, actorId)` — set `updatedBy`, don't touch `createdBy`. Re-check existence (`findById`) for 404 not P2025.
- `remove(id, actorId)` — hard `delete` for transient; `update({ deletedAt: new Date(), deletedBy: actorId })` for retention. See **Delete semantics** below.
- **Don't try/catch Prisma errors.** The global filter maps P2002→409 (field-aware via `err.meta.target`), P2003→400, P2025→404, else 500.
- **Throw via `Errors.*`** (`src/common/errors/errors.ts`), never raw `new NotFoundException(...)` etc. — ESLint enforces this.

## List queries (search, sort, resource-specific filters)

`MetaQueryDto` from `src/common/dto/meta-query.dto.ts`:

| Field       | Notes                                                                    |
|-------------|--------------------------------------------------------------------------|
| `page`      | default 1                                                                |
| `perPage`   | default 20, max 100                                                      |
| `search`    | trimmed; whitespace-only treated as no filter                           |
| `sortBy`    | resource-specific allowlist via `buildOrderBy` — disallowed value → 400  |
| `sortOrder` | enum `asc`/`desc`                                                        |

**Sort.** Allowlist next to the service; call `buildOrderBy` inside `buildListArgs`. Disallowed `sortBy` → 400 (`Errors.badRequest`). Never let untrusted strings reach `Prisma.orderBy`.

**Search.** Private `buildSearchWhere(term)` returning `Prisma.<Model>WhereInput | undefined`. Apply to **both** `findMany` and `count` so `meta.total` reflects the filtered set. Soft-delete models nested inside the search OR need an explicit `deletedAt: null` (the scoped client only filters top-level reads). Use `mode: 'insensitive'` (Postgres ILIKE).

**Resource-specific filters** (e.g. `?status=active`). Extend `MetaQueryDto` with class-validator decorators — never read raw query strings. Compose into `where` alongside search; pass the single `where` to both `findMany` and `count`. Cross-cutting params (cursor, dateFrom, includeDeleted) belong on `MetaQueryDto` so every list endpoint picks them up in lockstep.

### Actor-scoped list endpoints

When a list must filter by the auth user's role (users see only their own rows, admins see all), the **controller** mutates the query DTO after validation via a private `scopeQueryToActor(query, current)` — if `current.role === Role.USER`, set `query.userId = current.id` (overrides anything the client sent). A client-supplied `?userId=<other>` is silently overridden (syntactically valid, so a 403 would be wrong — the server just doesn't trust the client's userId). Service stays role-agnostic; scoping is an HTTP/auth concern.

## Audit fields

`createdBy`/`updatedBy` do **not** auto-populate — every mutating method takes `actorId: string | null` and writes it. Controllers pass `@CurrentUser().id`. For unauthenticated creates pass `null`. Deliberate explicit-arg pattern — actor visible at every callsite.

## Response DTO

Always construct via `new <Resource>ResponseDto(row)`. Never return raw Prisma rows — secrets leak.

**Audit columns are hidden from frontend.** Only `createdAt`/`updatedAt` exposed. `createdBy`, `updatedBy`, `deletedAt`, `deletedBy` kept in DB but stripped from API. **Pair `@ApiHideProperty()` with `@Exclude()`** — independent systems (Swagger build-time vs class-transformer runtime). Both needed. Skeleton in `docs/resource-pattern.md`.

**E2E tests**: assertions on audit columns must read DB directly (`app.get(PrismaService).<model>.findUniqueOrThrow(...)`), not API body.

### Response DTO with relations ("if loaded, expose it")

Models Laravel's `whenLoaded`: a DTO declares each related entity as an optional field; the constructor populates it **only when the corresponding Prisma include was used**. Three pieces per resource:

1. **`<Resource>Row` type** (in the DTO file) — `Resource & { relA?: ...; relB?: ... }`. Export it so other DTOs nesting this resource can compose the type.
2. **`<RESOURCE>_INCLUDE` constant** (in the service file) — single Prisma `include` shape used by every API-returning method. Compose nested includes by referencing the parent's exported `*_INCLUDE`. Soft-delete models nested under an include need explicit `where: { deletedAt: null }` (`prisma.scoped` only auto-filters top-level reads).
3. **DTO constructor** — destructure the relation keys out of the spread, then re-wrap: `const { relA, ...scalars } = row; Object.assign(this, scalars); if (relA) this.relA = new RelAResponseDto(relA);`. Stripping the raw key is mandatory — otherwise `Object.assign` leaks the unwrapped Prisma row (skipping DTO conversions) or a literal `null`.

Service `create`/`update` always refetch with the standard include before returning (for `create`, `tx.<model>.findUniqueOrThrow({ where, include })` inside the transaction). Adding a relation = three local edits (row type, include constant, constructor `if`).

## Migration

`yarn prisma:migrate dev --name add_<resource>`. **Until any deployed env has applied migrations, you may edit migration files in place freely.** After the first real deploy, Prisma records checksums in `_prisma_migrations` and drift-errors on changes — only add new migrations from then on. The `--create-only` workflow (`yarn prisma:migrate dev --create-only --name <name>` → author SQL → `yarn prisma:migrate dev` to apply) introduces raw-SQL constructs (partial unique indexes, generated columns).

## Delete semantics

Soft delete is not default — pick explicitly per resource.

**Hard delete when**: row is transient/operational (push tokens, sessions, OTPs); a unique constraint would block re-registration; FK cascades desired; no retention/audit value.

**Soft delete (`deletedAt` + `deletedBy`) when**: referenced by historical data (users, bookings, orders, payments); admin mistakes need reversibility; compliance retention applies; care about "who owned this at event time."

**GDPR erase is a third mode** — soft-delete retains PII; real erasure overwrites identifying cols. `User.gdprErase`: mark `deletedAt`, nullify PII, rehash password so no valid credential survives. Row stays (FK'd audit_logs/etc. remain valid) but carries nothing identifying.

**Current policy:**

| Resource | Admin delete | Self delete | gdpr-erase | isActive? | Why |
|---|---|---|---|---|---|
| `users` | soft | soft | anonymize + soft | yes (suspension) | Retention + recovery; `isActive` reserved for admin suspension |
| `app_versions` | hard | — | — | no | Release signal, not history |
| `device_tokens` | hard | — | — | no | Transient; unique `token` would block re-reg; FK cascade handles user delete |
| `audit_logs` | never via API | — | — | no | Append-only |

**New resource**: decide up front. Soft → both columns + add model name to `SOFT_DELETE_MODELS`, `remove()` does `update({ deletedAt, deletedBy })`. Hard → leave cols out, `remove()` does `prisma.<model>.delete`.

## Soft-delete filter: `prisma.scoped` vs raw `prisma`

`PrismaService` exposes two views on the same pool:

- **`this.prisma.user.*`** — raw, sees everything including soft-deleted. Admin/forensic/recovery code paths.
- **`this.prisma.scoped.user.*`** — filtered, auto-injects `deletedAt: null`. Every user-facing code path.

Mechanism: extension in `src/prisma/prisma-soft-delete.extension.ts` intercepts reads on any model in `SOFT_DELETE_MODELS` — injects `where: { deletedAt: null }` for `findFirst`/`findMany`/`count`; fetches-then-nullifies for `findUnique`/`findUniqueOrThrow` (unique where-type limitation). Writes pass through on both views (so admin restore via `update({ deletedAt: null })` still works).

**Adding a soft-delete model**: declare `deletedAt` + `deletedBy`, add the model name to `SOFT_DELETE_MODELS`. That's it. **Never rely on "remembered" filters for security** — the extension enforces it.

**Hot-path enforcement**: `AuthService.login` + `JwtStrategy.validate` use `prisma.scoped` — no explicit `if (user.deletedAt)` check (dead code since the query never returns deleted). **When to use raw**: admin `GET /users/:id` (recovery), retention jobs, forensic joins. `findByIdOrNull` and `findByEmail` use `scoped`.

## E2E test

Required for every resource. Min coverage: the five endpoints + access control (401 unauthenticated, 403 wrong role) + pagination (meta shape, invalid params → 400). See the `nestjs-e2e-test` skill for the harness.
