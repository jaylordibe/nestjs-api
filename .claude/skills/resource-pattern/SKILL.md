---
name: resource-pattern
description: Applies this repository's canonical NestJS and Prisma API-resource pattern: model and lifecycle choice, five endpoints, DTO validation and serialization, RBAC/CASL query scoping, pagination, audit fields, Swagger, soft deletion, partial uniqueness, migration preparation, and e2e coverage.
when_to_use: Use when adding a new API resource/module, completing an incomplete CRUD resource, adding list/search/filter behavior, changing response relations, choosing hard-delete versus soft-delete versus erasure, or modifying the canonical controller/service/DTO/Prisma pattern.
user-invocable: false
---

# API resource pattern

Read first:

- `CLAUDE.md`
- `docs/resource-pattern.md`
- `src/common/authorization/README.md`
- `src/common/errors/README.md`
- the nearest complete resource module and e2e spec
- the relevant Prisma models and migration state

Use source-owned skeletons for literal code. This skill defines decisions,
invariants, and completion checks.

Load `authorization` and `e2e-testing` when their concerns apply.

## 1. Validate the model before scaffolding

Before creating a module:

- search Prisma and `src/modules`;
- verify the concept does not already belong on an existing model;
- confirm ownership and cardinality;
- identify actors and tenant scope;
- decide whether the API truly needs a new resource;
- separate requested outcome from a ticket's suggested table/endpoint shape;
- reconcile consumer and migration impact.

Do not create a clean parallel resource for a concept the repository already
owns elsewhere.

## 2. Decide lifecycle and authority

Explicitly decide:

- hard delete;
- soft delete;
- anonymization/erasure;
- suspension through a distinct `isActive` state;
- append-only/no-delete.

Identify:

- actor/tenant owner;
- authoritative server-derived fields;
- immutable fields;
- state transitions;
- audit events;
- historical references and retention.

Soft deletion is a visibility/lifecycle mechanism, never an authorization
boundary.

## 3. Apply the canonical module contract

Default layout:

```text
src/modules/<resource>/
├── dto/
│   ├── create-<resource>.dto.ts
│   ├── update-<resource>.dto.ts
│   └── <resource>-response.dto.ts
├── <resource>.controller.ts
├── <resource>.service.ts
└── <resource>.module.ts
```

Keep transport, behavior, persistence, static registries, and pure helpers in
their proper layers.

Register the feature module through the established `AppModule` pattern.

## 4. Apply the five-endpoint API pattern

Where standard CRUD applies:

| Verb | Path | Controller method |
|---|---|---|
| POST | `/` | `create` |
| GET | `/` | `findPaginated` |
| GET | `/:id` | `findById` |
| PATCH | `/:id` | `update` |
| DELETE | `/:id` | `remove` |

Rules:

- use `findPaginated` and `findById`, never `findAll` or `findOne`;
- no unpaginated `/all`;
- static routes appear before `/:id`;
- UUID params use the established `ParseUUIDPipe`;
- update is PATCH with Swagger `PartialType`;
- delete returns 204;
- every handler declares exactly one access decorator;
- paginated handlers use `@ApiPaginatedResponse(T)`;
- non-paginated handlers declare an explicit response DTO;
- use a shared acknowledgement DTO for side-effect endpoints.

A resource may need fewer or additional domain-specific operations, but the ADR
must explain why it departs from the canonical contract.

## 5. Scope every query correctly

Do not inspect roles or trust client owner/tenant filters.

Build visibility through `AbilityScopedQueryService`:

- list query scope;
- record query scope;
- owner and BUSINESS/PLATFORM conditions;
- 404 for invisible records;
- 403 only after a visible record is loaded and the action is denied.

Compose search, resource filters, soft-delete behavior, and ability scope into
one authoritative `where` used by both `findMany` and `count`.

## 6. Preserve repository contracts

### Errors

- throw through `Errors.*`;
- let the global filter map standard Prisma errors;
- preserve stable `errorCode`;
- do not catch and rethrow generic framework exceptions.

### DTOs and responses

- request DTOs contain client-settable fields only;
- response DTOs wrap every Prisma row;
- sensitive/audit/lifecycle fields use both runtime and Swagger hiding;
- relation fields are exposed only when loaded and are re-wrapped through their
  own DTOs;
- never spread a raw included relation into the response.

### Audit

Every mutation accepts `actorId: string | null` and writes the required actor
columns.

Controllers pass the authenticated user ID, or `null` only for an intentionally
unauthenticated create.

Use `AuditService` for privileged/security-relevant domain actions.

### Configuration and providers

Use typed configuration and provider abstractions. No direct `process.env`,
unbounded remote call, or raw generic provider send.

## 7. Prepare data and migration safely

Follow:

- `references/schema-and-lifecycle.md`
- `references/query-and-contract.md`
- `references/migration-and-tests.md`

Do not run `prisma migrate dev`, `migrate reset`, `db push`, or apply a migration
to the local development database.

Prepare the complete schema change and one coherent migration file according to
the repository's deployed/not-yet-deployed migration policy. Use `yarn build`
to verify Prisma-generated shape.

## 8. Completion gate

A new resource is not complete until it has:

- correct lifecycle and ownership;
- authorization subject/catalog/scoped-query integration;
- five endpoint behavior or documented departure;
- DTO validation and response serialization;
- stable errors;
- bounded deterministic pagination/search/filter/sort;
- audit actor fields;
- Swagger contract;
- correct soft-delete/partial-unique behavior;
- migration file prepared but not locally applied;
- affected e2e coverage;
- `yarn build` and `yarn lint` evidence.
