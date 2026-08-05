---
name: gate-implement
description: Implements an explicitly accepted ADR in this NestJS, Prisma, PostgreSQL, Redis, and BullMQ API while enforcing its error, DTO, authorization, tenant-isolation, audit, Swagger, soft-delete, migration, testing, and operational contracts.
argument-hint: "<accepted ADR path>"
disable-model-invocation: true
model: inherit
effort: high
---

# Implement an accepted ADR

Input:

```text
$ARGUMENTS
```

## Hard gate

Read the complete ADR. It must explicitly state:

```text
Status: ACCEPTED
```

If it does not, stop.

Read `CLAUDE.md`, the relevant `.claude/standards/`, source-owned README
contracts, and project skills referenced by `CLAUDE.md`.

## Protect the worktree

Before edits:

- inspect Git status and current diff;
- preserve unrelated user work;
- never reset, clean, stash, checkout, or discard;
- never commit, push, merge, rebase, deploy, publish, transition tickets, apply
  migrations, reset databases, or modify production data;
- avoid unrelated cleanup.

If repository reality materially differs from the accepted ADR, stop and propose
an amendment.

## Implement in coherent slices

For each slice:

1. restate the behavior and invariant;
2. read complete relevant files and tests;
3. implement the smallest coherent complete change;
4. add/update tests;
5. run focused checks;
6. inspect the diff.

## Mandatory project contracts

### Errors and response serialization

- Throw through `Errors.*`; never construct Nest HTTP exceptions directly
  outside the error subsystem.
- Preserve the stable error envelope and machine-readable `errorCode`.
- Let the global filter handle Prisma P2002/P2003/P2025 unless the accepted ADR
  requires additional domain translation.
- Return `new <Resource>ResponseDto(row)`, never raw Prisma rows.
- Use both `@Exclude()` and `@ApiHideProperty()` for sensitive response fields.

### Validation and DTOs

- Respect whitelist + forbid-non-whitelisted global validation.
- Use established cross-field validators and `HHMM_PATTERN`.
- Use `@IsUtcIsoString()` for timestamps and `@IsDateString()` only for
  calendar dates.
- Use `toOptionalBoolean` plus `@Type(() => String)` for optional boolean query
  filters.
- Use TypeScript enums under `src/common/enums`; do not introduce PostgreSQL
  enums unless an accepted ADR explicitly changes project policy.

### Authorization and tenant isolation

- Every handler declares exactly one route access decorator.
- Do not add controller-level global auth guards already provided by the app.
- Add permissions to the permission catalog; the DB remains a projection.
- Treat JWT claims as `{ sub, jti }`; do not add role grants to JWT.
- Scope record reads and mutations through `AbilityScopedQueryService`.
- Never import `@casl/prisma` outside the authorized module.
- Return 404 when record visibility is denied; use 403 when the record is
  visible but the action is forbidden.
- Never trust client-supplied owner, tenant, provider, role, price, total,
  discount, entitlement, or approval state.

### Audit and observability

- Mutating service methods accept and persist `actorId: string | null`.
- Controllers pass `@CurrentUser().id` or `null` for an intentionally public
  create.
- Record privileged/security actions through `AuditService`.
- Do not supply caller-controlled `metadata.request`.
- Preserve request/queue correlation IDs.
- Extend pino redaction for new sensitive fields.
- Public health errors return fixed safe messages and log internal diagnostics.

### Prisma and PostgreSQL

- Access through `PrismaService`.
- Use `prisma.scoped` for top-level user-facing reads of soft-delete models.
- Explicitly filter nested to-many soft-delete includes; protect to-one access
  at the parent query.
- Do not treat soft deletion as authorization.
- Preserve partial unique index semantics; use `findFirst` for fields that are
  unique only among live rows.
- Do not replace partial indexes with `@@unique([field, deletedAt])`.
- Map camelCase fields to snake_case columns and models to plural snake_case
  tables.
- Prefix boolean fields with `is`.
- Cover full invariants with transactions and address concurrency.

### API and Swagger

- Use the five standard endpoints and fixed `findPaginated` / `findById` names
  when the resource pattern applies.
- Do not add unpaginated full-table endpoints.
- Use `MetaQueryDto`, `perPage <= 100`, and centralized list-query construction.
- Add `@ApiPaginatedResponse(T)` for paginated handlers.
- Add explicit response decorators for non-paginated handlers.
- Use shared typed acknowledgement DTOs, not inline objects or schemas.
- Import mapped DTO helpers from `@nestjs/swagger`.
- Treat request/response DTOs, enums, error codes, and events as consumer
  contracts.

### Config, providers, queues, and reliability

- Read config through typed `configuration.ts` keys with `getOrThrow`.
- Do not read `process.env` elsewhere.
- Use typed provider helpers rather than raw generic sends.
- New background work defaults to the BullMQ framework unless the queue README's
  decision table selects a scheduled sweep.
- Remote calls have explicit timeouts.
- Retry only transient failures with bounds, backoff, and jitter.
- Retried writes and job consumers are idempotent and duplicate-safe.
- Define cancellation, rescheduling, terminal failure, and poison-message
  behavior when applicable.

### Migrations

- Consolidate the complete schema change into one migration file.
- Do not apply migrations to the local dev DB.
- Do not reset, drop, re-seed, or destroy local data.
- Use `yarn build` to verify generated Prisma shape.
- Test DB migration execution belongs to the e2e harness.
- Let the user apply finalized migrations.

## Tests

Tests are implementation work.

Add/update relevant:

- unit specs for pure utilities and rules;
- affected e2e specs for the contract;
- error-envelope/error-code assertions;
- validation and serialization;
- authorization and tenant isolation;
- 404 versus 403;
- audit actor/event behavior;
- soft-delete and partial uniqueness;
- duplicate, replay, transaction, concurrency, retry, and queue behavior;
- regression reproduction;
- Swagger/consumer compatibility where testable.

Tests must remain safe under parallel workers. Never assume exclusive access
outside the worker's isolated database and Redis logical DB.

## Focused implementation checks

Run, as appropriate:

- affected unit specs;
- affected e2e spec(s) using repository-supported filtering;
- `yarn build`;
- `yarn lint`.

Do not run the full e2e suite unless the module is complete or the user asks.

## ADR reconciliation and handoff

Compare the diff to the ADR.

A material change requires an accepted amendment.

Report:

- behavior;
- files/contracts;
- security controls;
- tests;
- focused command results;
- migration files prepared but not applied;
- deviations/blockers;
- frontend/mobile handoff;
- ADR path.

Next:

```text
/gate-review <ADR path>
```
