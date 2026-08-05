---
name: gate-design
description: Designs a material change for this NestJS, Prisma, PostgreSQL, Redis, and BullMQ API by mapping repository reality, reconciling ticket claims, evaluating architecture alternatives, threat-modeling relevant surfaces, and producing an approval-gated ADR. Use for features, bugs, refactors, migrations, integrations, authorization changes, background jobs, and unclear blast radius.
argument-hint: "<ticket key | requirement | bug report | ADR path to resume>"
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

The only allowed write is an ADR under `docs/adr/NNNN-kebab-slug.md`, using
`.claude/templates/adr.md`. See `docs/adr/README.md`.

## Resume mode

If `$ARGUMENTS` is a path to an existing ADR, **resume it — do not start over.**
This is the normal way an ADR left `DRAFT` at the end of a day, or handed to
another developer, gets picked up.

1. Read the ADR completely, including `Status:` and §14 Open decisions and
   blockers. **§14 is the handoff contract** — it says what the previous author
   left unresolved and who owns it. Read it before anything else.
2. Refuse to proceed if `Status:` is `ACCEPTED` — that design is approved and
   belongs to `/gate-implement`; changing it now needs an amendment and renewed
   approval. Say so and stop.
3. **Re-establish repository reality before trusting a single existing claim.**
   An ADR cites `path:line` evidence and describes current behavior in §2, and
   `main` may have moved since it was written. `CLAUDE.md` requires verifying
   factual claims against the source before acting; the ADR's own claims are not
   exempt. Re-run `context-mapper` when the change is cross-cutting or the ADR is
   more than a few days old, and **explicitly re-grade §2's factual
   reconciliation table**. A stale §2 silently invalidates every option weighed
   on top of it.
4. Report what changed underneath the ADR, if anything, before continuing.
5. Resume at the earliest incomplete section. Keep decisions the previous author
   already justified; do not silently re-litigate them. If evidence now
   contradicts one, say which, why, and what it changes.
6. Keep `Status: DRAFT` while work remains. Move to `PROPOSED` only when every
   section is complete and §14 holds nothing that blocks a decision.

Never restart a resumed ADR from a blank template, and never renumber it.

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

Use `.claude/templates/adr.md`, at `docs/adr/NNNN-kebab-slug.md` with the next
free sequential number.

Set `Status: DRAFT` while the design is still being worked, and move it to
`PROPOSED` only when every section is complete. Parking an unfinished ADR at
`PROPOSED` means "ready for your approval" and invites someone to accept a
design that was never finished.

Include repository evidence, ticket reconciliation, recommendation, rejected
alternatives, threat model, exact file plan, tests, verification, migration,
rollout, rollback, non-goals, consumer handoff, and blockers.

**If the session ends before the design is complete**, leave `Status: DRAFT` and
write what remains into §14 with an owner, so the next person — or the next
session — can resume with `/gate-design <ADR path>`.

## 10. Approval gate

Set `Status: PROPOSED`, present the ADR, and stop.

**Do not approve it yourself and do not infer approval.** The decision is the
user's. Name any unresolved §14 row they would be deciding over, then hand off
per §11 below.

Approval belongs to `/gate-approve`, which reads the design back to them, takes
an explicit decision, and writes the `Status:` line and §15 together. It is
human-invocable only, which is what keeps a design from approving itself.

If they approve in this same conversation and explicitly ask you to record it,
you may — write **both** fields, approver from `git config user.name`, date from
the system. Ambiguous praise is not an approval.

## 11. Handoff

Follow `.claude/standards/gate-handoff.md`.

Close with the ADR path and its status, then offer:

- **Approve it now** — read the design back per
  `.claude/skills/gate-approve/SKILL.md` and record their explicit decision.
- **Keep refining** — stay at `DRAFT`, write what remains into §14.
- **Stop here** — they run `/gate-approve <adr>` themselves.

If the ADR is still `DRAFT`, do not offer approval at all. Say what §14 still
holds and that `/gate-design <adr>` resumes it.
