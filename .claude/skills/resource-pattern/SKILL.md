---
name: resource-pattern
description: Applies this repository's canonical NestJS and Prisma API-resource pattern: lifecycle choice, module layout, the five endpoints, service and list-query shape, response relations, and the completion gate for a new resource.
when_to_use: Use when adding a new API resource/module, completing an incomplete CRUD resource, adding list/search/filter behavior, changing response relations, choosing hard-delete versus soft-delete versus erasure, or modifying the canonical controller/service/DTO/Prisma pattern.
user-invocable: false
---

# API resource pattern

The rules every resource obeys — errors, validation, response DTOs, schema
naming, audit fields, the five endpoints, Swagger, partial uniqueness, soft
delete, migrations — are one-liners in `AGENTS.md` with their mechanics and
reasons in `docs/engineering-conventions.md`. This skill does not restate them.
It holds the decisions a new resource needs and the gate it must pass.

| Need | Owner |
|---|---|
| copy-pasteable controller/service/DTO code | `docs/resource-pattern.md` |
| query scoping, 404 vs 403, a new subject | `src/common/authorization/README.md` (and the `authorization` skill) |
| error codes and the envelope | `src/common/errors/README.md` |
| migration policy | `AGENTS.md` (Non-obvious invariants); `docs/engineering-conventions.md` (Prisma 7) |
| e2e coverage | the `e2e-testing` skill, `references/resource-and-contract-tests.md` |

Then read the nearest complete resource module and its e2e spec.

## 1. Decide lifecycle and authority

Explicitly choose one: hard delete, soft delete, anonymization/erasure,
suspension through a distinct `isActive` state, or append-only/no-delete —
`references/schema-and-lifecycle.md` says when each fits.

Identify the actor and tenant owner, the authoritative server-derived fields,
immutable fields, state transitions, audit events, and historical references
and retention.

## 2. Module layout

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

Register the feature module through the established `AppModule` pattern.

## 3. Endpoint details the conventions leave open

| Verb | Path | Controller method |
|---|---|---|
| POST | `/` | `create` |
| GET | `/` | `findPaginated` |
| GET | `/:id` | `findById` |
| PATCH | `/:id` | `update` |
| DELETE | `/:id` | `remove` |

- static routes appear before `/:id`;
- UUID params use the established `ParseUUIDPipe`;
- update DTOs use Swagger `PartialType`.

A resource may need fewer or additional domain operations; the plan says why it
departs from this contract.

## 4. Service and list query

`references/query-and-contract.md` — what each service method is responsible
for, how `buildListArgs` composes one `where` for `findMany` and `count`, and
how loaded relations are serialized.

## 5. Completion gate

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
