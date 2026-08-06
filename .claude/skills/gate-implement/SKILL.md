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

## Contracts to enforce

**The contracts live in `CLAUDE.md` — *Cross-cutting conventions* — and in
`.claude/standards/`. This skill does not restate them.**

That is a deliberate constraint, not an omission. A second copy of a contract is
a second thing to drift, and nothing can detect a prose list that has quietly
fallen behind the rule it paraphrases. `CLAUDE.md` is always in context; the
standards and the source-owned READMEs are one read away. Work from those, never
from a summary — including this one.

What this skill owns is the **checklist of lenses**: the areas a change in this
repository must be examined through before it is complete. For each one that the
ADR touches, go to the authoritative text and satisfy it.

| Lens | Authoritative source |
|---|---|
| Errors, `errorCode`, response DTOs, serialization | `CLAUDE.md`; `src/common/errors/README.md` |
| Validation, DTO shape, datetime and query-boolean handling | `CLAUDE.md`; `.claude/standards/coding.md` |
| Route access metadata, permissions, tenant scope, 404-vs-403 | `CLAUDE.md`; `src/common/authorization/README.md`; `authorization` skill |
| Audit actor fields, audit events, logging and redaction | `CLAUDE.md`; `.claude/standards/security.md` |
| Prisma models, soft delete, partial uniqueness, transactions | `CLAUDE.md`; `resource-pattern` skill |
| Endpoints, pagination, Swagger, consumer contracts | `CLAUDE.md`; `.claude/standards/architecture.md` |
| Config, providers, queues, timeouts, retries, idempotency | `CLAUDE.md`; `src/common/queue/README.md` |
| Migrations and schema change | `CLAUDE.md` — *Migrations while work is in progress* is STRICT |
| Naming, file responsibility, completion hygiene | `CLAUDE.md`; `.claude/standards/coding.md` |

Two rules are repeated here rather than referenced, because violating either is
unrecoverable rather than merely wrong:

- **Do not apply migrations to any local or shared database.** `yarn build`
  verifies the generated Prisma shape. The e2e harness owns the only database
  that may be dropped automatically. Consolidate the change into one migration
  file and let the human apply it.
- **Do not reset, drop, or re-seed local data**, for any reason, without an
  explicit instruction in this conversation.

## Tests

Tests are implementation work, not a follow-up.

Cover the scenarios in `.claude/standards/testing.md` — *Required scenarios* —
that this change makes reachable, plus a regression case for any defect fixed.
Placement, harness, and worker-isolation rules are in the `e2e-testing` skill.

The one property worth restating: specs run in parallel against a per-worker
cloned database and Redis logical DB, so a spec must never assume exclusive
access to anything outside its own worker.

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
- frontend/mobile handoff, per the *Consumers* table in `CLAUDE.md`;
- ADR path.

## Handoff

Follow `.claude/standards/gate-handoff.md`, starting with its §0 mode table.

Close with the files changed, the contracts touched, the focused checks that
actually ran, and any migration prepared but **not** applied.

**Standalone** — then offer to continue into `/gate-review <adr>`, and
**recommend a fresh session when the change is High or Critical risk**. A review
carries more weight from a context that did not just write the code; the
reviewer should be re-reading the diff, not recalling its own intentions.

**Conductor** (`/work-item` Stage 3) — emit the stage marker and go straight into
the review. Do not offer, and do not recommend a fresh session: independence
there comes from the review's read-only subagents, which is why that fan-out is
mandatory rather than optional on High and Critical work.
