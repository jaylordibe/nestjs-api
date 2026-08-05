---
name: ticket
description: Drives a Jira issue or pasted ticket through repository mapping, an approval-gated ADR, implementation, independent project-specific review, read-only validation, presentation, and an optional single issue comment. Use when the user explicitly wants the complete ticket-to-validated-diff workflow.
argument-hint: "<TICKET-KEY | pasted ticket text>"
disable-model-invocation: true
model: inherit
effort: high
---

# Ticket-to-validated-diff conductor

Ticket input:

```text
$ARGUMENTS
```

Run this workflow in the **main conversation context**.

Do not fork the entire skill into a subagent. The conductor must maintain the
task checklist, stop for human approval, delegate multiple independent agents,
edit only after approval, and resume after discussion or compaction.

## Non-negotiable boundaries

- Never edit product source before explicit approval of the ADR.
- Never silently diverge from the accepted ADR.
- Never commit, amend, push, force-push, merge, rebase, tag, publish, deploy,
  apply migrations, reset databases, or modify production data.
- Never transition an issue or edit its fields.
- Preserve unrelated worktree changes.
- Never report a check as passing unless it actually ran and passed for the
  stated scope.
- Never claim committed, pushed, merged, released, deployed, secure, or
  production-ready beyond the evidence.

Invoking `/ticket <real issue key>` authorizes exactly one Stage 7 issue comment
when the configured tracker is connected. It does not authorize any other issue
write.

## Normative stage playbooks

At the start, read:

- `CLAUDE.md`
- `.claude/skills/gate-design/SKILL.md`
- `.claude/skills/gate-approve/SKILL.md`
- `.claude/skills/gate-implement/SKILL.md`
- `.claude/skills/gate-review/SKILL.md`
- `.claude/skills/gate-validate/SKILL.md`
- relevant `.claude/standards/`
- relevant source-owned contract READMEs

The five phase skills are human-only and must not be recursively invoked through
the Skill tool. Treat their contents as the authoritative procedures for Stages
2–5.

## Pipeline state — do this first

Create a persistent task checklist containing:

1. Understand
2. Design — GATE 1
3. Implement
4. Review
5. Validate
6. Present — HUMAN GIT/RELEASE GATE
7. Report to issue tracker

Rules:

- Keep exactly one stage `in_progress`.
- Mark a stage complete only when its exit criteria are satisfied.
- Keep Stage 2 in progress throughout all ADR discussion.
- Approval messages such as “approved,” “looks good,” or “go ahead” resume the
  pending pipeline; do not treat them as an unrelated request.
- Re-read the task list and accepted ADR after approval and after context
  compaction.
- Never skip Review, Validate, Present, or Report because approval arrived after
  a long discussion.

If this is a resumed session, search for an existing ADR associated with the
ticket, inspect its status and the current diff, and resume from the earliest
incomplete safe stage. Never restart blindly or post a duplicate issue comment.

## Input resolution

If `$ARGUMENTS` is a real issue key and the configured issue-tracker MCP is
available:

- fetch summary, description, acceptance criteria, comments or linked context
  needed to understand the request;
- record the issue key for Stage 7.

Otherwise, treat `$ARGUMENTS` as pasted ticket content.

Ask for missing ticket details only when neither source provides enough product
intent to design safely.

# Stage 1 — Understand

Set Stage 1 `in_progress`.

Launch `context-mapper` with the complete ticket.

For large or cross-cutting work, the main conductor may launch parallel,
read-only agents scoped by subsystem:

- `architect`
- `security`
- `api`
- `database`
- `performance`
- `tester`

Subagents cannot delegate further. The main conductor owns all fan-out and
synthesis.

Read every result fully and verify important claims against source.

The understanding must include:

- requested WHAT and prescribed HOW;
- authoritative current behavior;
- entry points and execution/data flow;
- affected modules/files;
- DTOs, enums, stable error codes, Swagger, and consumer contracts;
- Prisma models, soft deletion, partial uniqueness, indexes, transactions, and
  migration impact;
- RBAC/CASL permission, PLATFORM/BUSINESS scope, ownership, and 404/403 behavior;
- audits, logging/redaction, queues/jobs/providers, retries/idempotency, and
  operations;
- affected tests;
- ticket factual claims graded against repository reality;
- product decisions, technical unknowns, blockers, and confidence.

Do not choose the final design until the map is complete.

Mark Stage 1 complete and Stage 2 in progress.

# Stage 2 — Design [GATE 1]

Follow `.claude/skills/gate-design/SKILL.md`.

Enter Plan mode when available. Remain read-only even if Plan mode is
unavailable.

Create an ADR using `.claude/templates/adr.md` with:

```text
Status: PROPOSED
```

The ADR must:

- recommend rather than transcribe;
- lead with the evidence-supported approach;
- record ticket-vs-code discrepancies;
- compare credible alternatives;
- classify risk;
- threat-model High/Critical or security-sensitive changes;
- specify exact file responsibilities and repository contracts;
- map requirements/risks to tests and validation;
- address web/mobile/external handoffs;
- address migration, deployment ordering, rollback/roll-forward, and non-goals;
- identify unresolved product decisions and blockers.

Present the ADR through the normal Plan/approval interface and stop.

Do not mark Stage 2 complete until the user explicitly approves.

Before asking for a decision, read back the recommendation, the trade-off
accepted by rejecting the alternatives, residual risk, non-goals, and **every
unresolved §14 row** — the contract in `.claude/skills/gate-approve/SKILL.md`.
Ambiguous praise is not an approval; the user's decision must be explicit.

On approval:

1. re-read the checklist;
2. re-read the ADR;
3. write **both** the `Status: ACCEPTED` line and §15 — `Decision: Approved`,
   `Approved by:` from `git config user.name`, `Date:` from the system, and any
   conditions the user stated verbatim. `/gate-implement` branches on `Status:`
   alone, so a header-only edit records an approval with no approver;
   `yarn claude:validate` fails the build when the two disagree;
4. mark Stage 2 complete;
5. mark Stage 3 in progress;
6. continue the pipeline in the same session.

If the user requests changes, revise the ADR and remain at Stage 2.

If the session ends mid-design, set `Status: DRAFT` and write what remains into
§14 with an owner, so the work resumes with `/gate-design <ADR path>` rather than
restarting. Never leave an unfinished ADR at `PROPOSED` — that reads as "ready
for your approval".

# Stage 3 — Implement

Follow `.claude/skills/gate-implement/SKILL.md` and the accepted ADR.

Before editing:

- inspect Git status/diff;
- preserve unrelated changes;
- confirm repository reality still matches the ADR.

Implement coherent slices with tests.

Enforce every applicable `CLAUDE.md` contract, including:

- intention-revealing complete names;
- `Errors.*`, stable error codes, and global Prisma error handling;
- response DTO instances and sensitive-field exclusion;
- established DTO validation and UTC/query-boolean conventions;
- exactly one route access decorator;
- query-level `AbilityScopedQueryService` scope;
- 404-versus-403 behavior;
- server-derived ownership, roles, prices, totals, discounts, and entitlements;
- actor-scoped audit fields and `AuditService`;
- `prisma.scoped`, nested soft-delete filtering, and partial unique indexes;
- snake_case mappings and `is` booleans;
- Swagger response decorators and bounded pagination;
- typed config/provider/queue abstractions;
- timeouts, bounded retries, idempotency, duplicate safety, correlation, and
  terminal failure behavior;
- one consolidated migration file and no local migration application;
- parallel-safe tests.

Run focused checks after coherent slices.

If a material ADR divergence becomes necessary, stop Stage 3, propose an ADR
amendment, and return to the approval gate.

When the accepted implementation and focused tests are complete, mark Stage 3
complete and Stage 4 in progress.

# Stage 4 — Review

Follow `.claude/skills/gate-review/SKILL.md`.

Launch relevant project agents independently and in parallel:

- `architect`
- `reviewer`
- `security`
- `tester`
- `api`
- `database`
- `performance`

Verify every candidate finding before reporting or fixing it.

Supplementary bundled skills:

- invoke `/security-review` for High/Critical work and changes involving auth,
  authorization, tenancy, money, uploads, webhooks, secrets, or admin behavior,
  when it is available through the Skill tool;
- invoke `/simplify` only after correctness and security findings are resolved,
  when useful and available; verify every proposed change against the ADR and
  project rules.

Do not rely on bundled skills as the only review.

Remediate verified findings within accepted scope, add regression tests, run
focused checks, and re-run affected reviewers.

Perform at most two complete remediation/re-review cycles.

Stage 4 exits only when:

- no unresolved Critical or High finding remains;
- any unresolved Medium/risk is plainly documented and requires human/product
  action;
- review fixes have focused test evidence.

Mark Stage 4 complete and Stage 5 in progress.

# Stage 5 — Validate

Follow `.claude/skills/gate-validate/SKILL.md`.

Validation is read-only.

At minimum, when applicable:

- run `yarn build`;
- run `yarn lint`;
- run affected unit specs;
- run affected e2e specs using the separate `.env.test` stack and worker
  isolation;
- inspect database/migration safety without applying migrations to local dev;
- validate authorization, tenant, stable error, serialization, audit,
  throttling, queue, and compatibility evidence;
- use `/verify` or `/run` for a meaningful runnable surface when available.

Do not run full `yarn test:e2e` unless the module is complete or the user asks.

Return exactly one Stage 5 verdict:

- `PASS`
- `FAIL`
- `BLOCKED`

A partial/filtered suite must be labeled partial. Skipped, unavailable, or flaky
is not PASS.

If the verdict is FAIL because of an implementation defect, return to Stage 3 or
4 as appropriate, fix within the ADR, then re-review and re-validate.

If BLOCKED, do not invent evidence.

Mark Stage 5 complete only when the evidence report is complete, even if the
verdict is FAIL or BLOCKED. Mark Stage 6 in progress.

# Stage 6 — Present [HUMAN GIT/RELEASE GATE]

Present:

- behavior implemented;
- concise diff/module summary;
- contract and consumer handoff;
- review findings and fixes;
- exact validation table and verdict;
- migration files prepared but not applied;
- blockers and residual risks;
- recommended human next steps.

Be explicit that the work exists only in the working tree.

Do not perform Git writes, PR publication, migration application, deployment,
release, or risk acceptance.

Stage 6 is a human ownership boundary, not an additional permission for Stage 7.
After presenting, mark Stage 6 complete and Stage 7 in progress.

# Stage 7 — Report to issue tracker

Run only when all are true:

- input was a real issue key;
- the tracker MCP is connected;
- work was not abandoned;
- no completion comment has already been posted by this pipeline run.

Post exactly one Markdown comment. Do not ask for a separate confirmation; the
original `/ticket <ISSUE-KEY>` invocation authorized this single comment.

Never transition the issue or edit fields.

The comment:

- starts with an honest one-line status;
- is short and non-technical;
- contains no file paths, function names, class names, internal error codes, or
  detailed implementation reasoning;
- never claims commit, push, merge, release, or deployment.

Answer exactly:

1. What behavior changed?
2. What changed beyond the request that QA should know?
3. What remains blocked, who owns it, and what must ship first?

If Stage 4 or 5 left a failure or blocker, say so.

When a cross-repository blocker needs its own linked issue, recommend that the
human create it or explicitly ask for its creation. Do not create one under this
authorization.

After the comment succeeds:

- mark Stage 7 complete;
- tell the user it was posted;
- confirm issue status and fields were untouched.

If tracker reporting is not applicable, mark Stage 7 skipped/completed and say
why.
