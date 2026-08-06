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
   exempt. Follow the mapping rule in §2 below, then **explicitly re-grade §2's
   factual reconciliation table** in the ADR. A stale §2 silently invalidates
   every option weighed on top of it.
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

**When `context-mapper` is required.** This is the single statement of the rule;
Resume mode defers to it rather than restating it.

- **New design** — always. Launch `context-mapper` **first**, before any option
  is weighed. You cannot judge a change you have not mapped.
- **Resumed ADR** — the map already exists in the file's §2. Re-run
  `context-mapper` when the change is cross-cutting, the ADR is more than a few
  days old, or the worktree has moved under it. Otherwise re-verify the ADR's
  existing `path:line` claims directly, which is cheaper and more precise for a
  small blast radius.

Never skip both. **State which method you used and why** — an unexplained skip
is indistinguishable from an oversight to whoever reads the ADR next.

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

Classify the change against `CLAUDE.md` — *Risk classification*. Its High row is
the trigger list; take the higher tier whenever the change sits on a boundary.

**The tier decides how much design this change gets, and whether it gets an ADR
at all.**

| Tier | Design artifact |
|---|---|
| **Low** | **No ADR.** Say so, state the tier and the evidence, and hand back — the change goes straight to implementation, and `/gate-review` and `/gate-validate` still run. |
| **Medium** | ADR with §§1–7 and §§9–14. Sections 8 (threat model) and the alternatives comparison stay brief unless the change earns them. |
| **High** | Full ADR, explicit threat model in §8, at least two credible alternatives compared, migration/rollback analysis. |
| **Critical** | Everything High requires, and the ADR states plainly that automated review is not sufficient and names the human review still owed. |

This tiering exists because a ceremony applied uniformly is a ceremony that gets
skipped, and a skipped step reads exactly like a completed one. Refusing to write
an ADR for a copy fix is what keeps the ADR meaningful for a schema change.

Do not use a Low classification to avoid an ADR the change actually needs. If you
are choosing between two tiers, you are in the higher one.

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

Produce a file-by-file plan: for each file, what changes and which contract it
has to satisfy.

**Name the contracts; do not restate them.** The authoritative text is
`CLAUDE.md` — *Cross-cutting conventions* — plus `.claude/standards/` and the
source-owned READMEs, and `gate-implement` carries the lens-to-source table. An
ADR that paraphrases a convention creates a third copy that outlives the rule it
was copied from; an ADR that cites one stays correct for free.

What the plan must decide, because the sources cannot decide it for you:

- which route access decorator each new or changed handler declares, and why;
- where the tenant/ownership boundary sits for each query;
- which `errorCode` values are new, and whether any existing one changes meaning;
- which response fields are sensitive, and what the DTO exposes;
- the exact Prisma shape, including soft-delete classification and any partial
  unique index;
- whether new background work belongs on the queue or a scheduled sweep;
- the single consolidated migration, prepared but not applied.

## 8. Plan tests and verification

Map each requirement and each identified risk to a specific test. The catalogue
of scenarios is `.claude/standards/testing.md` — *Required scenarios*; the design
work is deciding **which of them this change makes reachable**, and naming the
spec file that will cover each.

A risk with no test mapped to it is an accepted risk. Say so in §14 rather than
leaving the gap implicit.

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
