---
name: gate-design
description: Designs a material change for this NestJS, Prisma, PostgreSQL, Redis, and BullMQ API by mapping repository reality, reconciling ticket claims, evaluating architecture alternatives, threat-modeling relevant surfaces, and producing an approval-gated ADR. Use for features, bugs, refactors, migrations, integrations, authorization changes, background jobs, and unclear blast radius.
argument-hint: "<ticket key | requirement | bug report | proposed change>"
disable-model-invocation: true
model: inherit
effort: high
---

# Design a change

Input:

```text
$ARGUMENTS
```

This skill is design-only. Do not edit product source, tests, Prisma schema,
migration files, configuration, lockfiles, generated files, or deployment
artifacts.

The only allowed write is an ADR under the project's chosen ADR location, using
`.claude/templates/adr.md`.

## Pipeline

Track these stages:

1. Establish requirement
2. Map repository reality
3. Reconcile ticket and code
4. Classify risk
5. Evaluate alternatives
6. Threat-model
7. Plan file and contract changes
8. Plan tests and verification
9. Write ADR
10. Stop at approval

## 1. Establish requirement

Extract:

- desired outcome and acceptance criteria;
- users, actors, roles, and scopes;
- explicit constraints and non-goals;
- factual claims;
- prescribed implementation method;
- ambiguous product behavior;
- externally visible contract expectations.

Separate the **WHAT** from the ticket's proposed **HOW**.

Do not silently decide unresolved product behavior.

## 2. Map repository reality

Launch the `context-mapper` agent first.

For cross-cutting work, use additional project agents in parallel:

- `architect`
- `security`
- `api`
- `database`
- `performance`
- `tester`

Read the complete map before deciding.

The map must cover:

- NestJS modules, controllers, services, providers, guards, decorators, jobs,
  listeners, processors, and external adapters;
- DTOs, response DTO constructors, enums, `Errors.*` codes, Swagger decorators,
  and stable client contracts;
- Prisma models, relations, `@map`/`@@map`, soft-delete classification,
  `prisma.scoped`, partial unique indexes, selectors, constraints, transactions,
  and migration implications;
- RBAC/CASL permission catalog, route metadata, `AbilityScopedQueryService`,
  PLATFORM/BUSINESS scope, ownership, and 404-versus-403 behavior;
- audit actor fields, `AuditService`, request metadata, pino redaction, request
  IDs, and queue correlation;
- BullMQ/scheduled-job choice, retries, idempotency, duplicates, cancellation,
  rescheduling, poison messages, and failure recovery;
- affected unit/e2e specs and the isolated test topology;
- frontend/mobile or external consumer handoffs.

## 3. Reconcile ticket and code

State plainly:

- requested product outcome;
- authoritative current behavior;
- confirmed, stale, incorrect, ambiguous, or not-found ticket claims;
- constraints imposed by existing contracts;
- whether the prescribed method is sound;
- recommended technical divergence and trade-offs.

A faithful implementation of a wrong premise is not acceptable.

## 4. Classify risk

Use `CLAUDE.md` risk levels.

Explicitly identify whether the change touches:

- authentication or account recovery;
- permissions, ownership, role rank, or tenant scope;
- PII or security-sensitive logs;
- money, pricing, totals, discounts, or entitlements;
- public endpoints, OTP/email/SMS dispatch, or throttling;
- uploads, URLs, webhooks, parsers, or external providers;
- Prisma schema, existing data, indexes, uniqueness, or soft deletion;
- transactions, counters, races, retries, or jobs;
- stable error codes, DTOs, response shapes, or event payloads;
- infrastructure or deployment ordering.

High/Critical work requires an explicit threat model.

## 5. Evaluate alternatives

For Medium-or-higher work, evaluate at least two credible approaches unless the
repository leaves only one viable approach.

Compare:

- correctness and invariant enforcement;
- authorization and security;
- fit with module/layer boundaries;
- compatibility with web/mobile consumers;
- Prisma/PostgreSQL correctness;
- migration and rollback safety;
- queue/retry/partial-failure behavior;
- testability;
- operational complexity;
- maintainability.

Prefer the proper coherent end state within approved scope. Do not over-engineer.

## 6. Threat-model

Use `security` and `.claude/templates/threat-model.md`.

At minimum consider:

- authentication and function/object authorization;
- PLATFORM/BUSINESS scope and ownership;
- enumeration and 404/403 behavior;
- role/FK escalation and mass assignment;
- client-controlled money/price/entitlement fields;
- timing and disposable-email behavior where auth is involved;
- replay, duplicate delivery, and race conditions;
- public route throttling;
- upload/URL/parser risks;
- log/error/Swagger data leakage;
- webhook authenticity;
- audit gaps.

## 7. Plan exact project changes

Produce a file-by-file plan.

Address exact repository conventions:

- route annotation: exactly one of `@Public()`, `@AuthenticatedOnly()`, or
  `@RequirePermission(...)`;
- query-level authorization through `AbilityScopedQueryService`;
- `Errors.*` factory and stable `errorCode`;
- `new <Resource>ResponseDto(row)` and sensitive-field exclusion;
- DTO validation, UTC timestamp handling, query-boolean transforms;
- Swagger response decorators and `@ApiPaginatedResponse`;
- `createdBy`/`updatedBy` actor propagation;
- `AuditService` for privileged/security actions;
- Prisma soft-delete nested-read filtering;
- partial unique index implications and `findFirst` selectors;
- snake_case mappings and `is`-prefixed booleans;
- config through `configuration.ts` and `getOrThrow`;
- remote timeouts and bounded retries;
- queue correlation and idempotency;
- one consolidated migration file and no local application.

## 8. Plan tests and verification

Map requirements and risks to:

- unit specs for pure helpers and domain rules;
- controller/service integration behavior;
- affected e2e specs;
- stable error-envelope and `errorCode` assertions;
- response serialization and secret exclusion;
- route authorization metadata;
- permission/ownership/tenant isolation;
- 404 enumeration protection and 403 action denial;
- soft-delete visibility and partial uniqueness;
- concurrency, duplicate, replay, retry, and failure behavior;
- Swagger/contract compatibility;
- queue and audit behavior.

Verification must include:

- `yarn build`;
- `yarn lint`;
- affected e2e spec(s);
- affected unit specs when present;
- actual runtime exercise when a meaningful surface exists.

Do not plan to apply migrations to the local dev database.

## 9. Write the ADR

Use `.claude/templates/adr.md`.

Set:

```text
Status: PROPOSED
```

Include repository evidence, ticket reconciliation, recommendation, rejected
alternatives, threat model, exact file plan, tests, verification, migration,
rollout, rollback, non-goals, consumer handoff, and blockers.

## 10. Approval gate

Present the ADR and stop.

Only explicit approval changes it to:

```text
Status: ACCEPTED
```

Then direct the user to:

```text
/gate-implement <ADR path>
```
