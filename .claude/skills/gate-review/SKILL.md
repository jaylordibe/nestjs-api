---
name: gate-review
description: Independently reviews the current NestJS and Prisma change for accepted-design conformance, correctness, application security, RBAC/CASL tenant isolation, API/error contracts, database and migration safety, BullMQ reliability, tests, and performance; fixes verified findings and re-reviews.
argument-hint: "[ADR path | base ref | review focus]"
disable-model-invocation: true
model: inherit
effort: high
---

# Review the current change

Input:

```text
$ARGUMENTS
```

The main agent is the conductor and remediation owner. Specialist agents are
read-only and independent.

## 1. Establish exact target

State the exact target:

- accepted ADR;
- staged/unstaged worktree diff;
- explicit base reference;
- changed files and contracts.

Exclude unrelated user changes.

## 2. Delegate review

Run relevant agents in parallel:

- `architect`
- `reviewer`
- `security`
- `tester`
- `api`
- `database`
- `performance`

Provide the ADR, exact diff, changed-file scope, `CLAUDE.md`, relevant standards,
and source-owned README contracts.

## 3. Mandatory project checks

### Design and architecture

- accepted ADR and deliberate non-goals;
- `src/common` leaf-layer rule;
- module ownership and dependency direction;
- no duplicated business rules or parallel implementations;
- coherent complete migration across all in-scope call sites;
- no unrelated scope or speculative abstraction.

### Naming and code quality

- intention-revealing full names in locals, callbacks, declarations, files,
  DTOs, and loops;
- no prohibited abbreviations or vague placeholders;
- data/registries separated from behavior;
- pure reusable helpers in `src/common/util` with specs;
- obsolete code removed;
- new conventions made self-enforcing where practical.

### Errors, DTOs, and API

- no direct Nest HTTP exception construction;
- stable `Errors.*` code and envelope;
- no raw Prisma rows;
- response DTO constructors;
- sensitive `@Exclude()` + `@ApiHideProperty()`;
- exact validation patterns;
- explicit Swagger response types;
- `@ApiPaginatedResponse`;
- acknowledgement DTOs;
- no unpaginated full-table route;
- compatibility of required/optional/null fields, enums, and error codes.

### Authorization and AppSec

- exactly one access decorator per route;
- permission catalog and route boot audit;
- object/tenant scope in the Prisma query through
  `AbilityScopedQueryService`;
- no direct external `@casl/prisma`;
- 404 for invisible records and 403 for visible forbidden actions;
- no client-trusted ownership, role, money, totals, discounts, or entitlements;
- public and dispatching endpoints have explicit throttling;
- enumeration/timing behavior preserved;
- mass assignment, FK/role escalation, replay, race, and abuse checked;
- logs/errors/Swagger do not leak secrets or sensitive data;
- audit actor and security events are present.

### Prisma and migration

- correct `prisma.scoped` use;
- nested soft-delete reads filtered;
- partial live-row unique index semantics preserved;
- `findFirst` used where Prisma has no unique selector;
- snake_case mappings and `is` booleans;
- transaction/invariant and concurrency safety;
- one consolidated migration;
- no evidence of local migration application/reset;
- expand/backfill/constraint/contract ordering if deployed environments exist.

### Queues, external providers, and reliability

- BullMQ versus scheduled-job decision follows repository guidance;
- typed provider methods;
- timeouts;
- bounded transient retries;
- idempotency and duplicate safety;
- correlation ID propagation;
- cancellation/rescheduling;
- terminal and poison-message behavior;
- actionable non-sensitive observability.

### Tests

- affected e2e contract coverage;
- unit coverage for pure rules;
- regression case;
- negative, boundary, authorization, and tenant tests;
- stable error-envelope assertions;
- serialization and secret exclusion;
- concurrency/replay/retry behavior;
- parallel-worker isolation assumptions;
- no weakened assertions, focused tests, broad sleeps, or hidden flakiness.

## 4. Verify every finding

For each candidate:

1. inspect surrounding source;
2. cite exact `path:line`;
3. state trigger and expected/actual behavior;
4. state impact;
5. assign Critical/High/Medium/Low/Note;
6. prescribe the smallest correct fix;
7. specify regression coverage;
8. state confidence.

Reject speculative, duplicate, irrelevant, or style-only findings.

### Adversarial verification — Critical and High only

You commissioned the review, so you are the worst available judge of whether its
findings are real: the same context that produced a finding will tend to confirm
it. For each **Critical or High** finding on a **High or Critical risk** change,
launch one independent agent — the specialist whose lens owns the finding — with
the single instruction to **refute** it:

> Here is a claimed defect at `path:line`: <claim>. Read the surrounding source
> and try to prove it is NOT a defect: that the trigger is unreachable, the
> invariant is enforced elsewhere, the behavior is intended, or the cited line
> does not say what the claim says. Default to `refuted: true` when the evidence
> is ambiguous. Return `refuted` plus the evidence that settles it.

A refuted finding is dropped and recorded in the rejected-findings summary with
the refutation. A surviving finding proceeds to remediation with its refutation
attempt on record — that record is what makes the severity credible later.

Do not run this for Medium and below, and do not run it on Low-risk changes; the
cycle costs more than the precision it buys there.

## 5. Remediate

- Fix verified Critical/High findings within accepted scope.
- Fix Medium findings unless they require product/architecture approval.
- Fix Low findings only when safe and local.
- Add regression tests.
- Request an ADR amendment for material divergence.
- Run affected tests, `yarn build`, and `yarn lint` after fixes.

Perform at most two full remediation/re-review cycles.

## 6. Report

Report:

- exact target;
- agents/lenses;
- findings by severity;
- fixes and tests;
- rejected findings summary;
- command evidence;
- unresolved blockers/risks;
- consumer handoff;
- readiness for `/gate-validate`.

Do not commit, push, deploy, apply migrations, transition tickets, or claim
production readiness.

## 7. Handoff

Follow `.claude/standards/gate-handoff.md`.

Close with findings by severity, what was fixed, what was rejected and why, and
the commands that actually ran. Then offer to continue into
`/gate-validate <adr>`.

**Do not offer to continue while any Critical or High finding is unresolved.**
Name what remains and stop — that is the whole purpose of this gate.
