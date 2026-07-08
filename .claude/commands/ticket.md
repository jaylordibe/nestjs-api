---
description: Drive a ticket from context-gathering to a verified diff, stopping at the plan-approval and commit gates.
argument-hint: <TICKET-KEY | pasted ticket text>
---

You are the **conductor** for the ticket-to-diff pipeline. Follow these stages in order. Two gates are non-negotiable: **never implement before the plan is approved, and never commit or push** (the human owns all git writes — a project hook enforces this).

## Track pipeline state (do this first)

Before Stage 1, create a persistent todo checklist with all six stages as items:
`1. Understand` · `2. Plan [GATE 1]` · `3. Implement` · `4. Review` · `5. Verify` · `6. Present [GATE 2]`.
Mark a stage `in_progress` when you enter it and `completed` when you leave it; keep exactly one stage `in_progress` at a time.

This checklist is the pipeline's **durable memory**. The plan gate (Stage 2) usually takes several rounds of back-and-forth, and the conversation may be summarized in between — so the original instructions can drift out of view. The checklist survives that. Therefore:

- Keep Stage 2 `in_progress` through the entire plan discussion; do not mark it completed until the user **approves** the plan.
- **When approval arrives, re-read the checklist and resume at the next pending stage (Stage 3 — Implement), then continue through Review → Verify → Present.** Do not treat a post-approval message ("looks good", "go ahead") as a standalone query — if a checklist with pending stages exists, you are mid-pipeline.
- Never skip Stages 4–6 just because approval came after a long discussion.

## Input

Ticket: $ARGUMENTS

If `$ARGUMENTS` is an issue key and an issue-tracker MCP (e.g. Atlassian/Jira) is connected, fetch the issue (summary, description, acceptance criteria). Otherwise treat `$ARGUMENTS` as the ticket content. If neither gives you enough to act on, ask for the ticket details before proceeding.

## Stage 1 — Understand (parallel, read-only)

Launch the `context-mapper` agent on the ticket to produce the impact map (touched files, contract surface, security surface, downstream consumers, tests implied). For a large or cross-cutting ticket, launch several `context-mapper` agents scoped to different subsystems in parallel. Read the map fully before designing anything.

## Stage 2 — Plan  [GATE 1]

Enter **Plan mode**. Produce an ADR per CLAUDE.md: Context → Approach (rationale + rejected alternatives) → file-by-file changes → tests → verification → what this deliberately does NOT do. Then **stop and present it via ExitPlanMode**. Do not edit any file until the user approves. A plan is not a green light.

## Stage 3 — Implement

Only after approval. Implement exactly the approved plan to the CLAUDE.md engineering bar: intention-revealing names everywhere (no `i`/`j`, no truncated identifiers), throw via the `Errors.*` factory (never `new *Exception`), return `new <Resource>ResponseDto(row)` (never raw Prisma rows), write actor-scoped audit fields, read soft-delete models via `prisma.scoped`, implement the five standard endpoints (no `/all`), and treat tests as part of the change. Delete what you replace. Consolidate any schema work into ONE migration and do NOT apply it to the local DB — `yarn build` verifies the shape. For a brand-new resource, follow the `nestjs-new-resource` skill.

## Stage 4 — Review (built-in engines, three lenses)

Run each and fold the findings back into the diff:
- `/code-review` — correctness bugs.
- `/security-review` — attack surface (mandatory for anything touching auth or money).
- `/simplify` — reuse / simplification cleanup.

## Stage 5 — Verify

- `yarn build` and `yarn lint` must pass.
- Run the **affected** e2e spec(s) — `yarn test:e2e` scoped to the touched module. Do not run the full suite unless the module is complete or the user asks.
- Where there is a runtime surface, run `/verify` (or `/run`) to exercise the actual flow, not just the tests.

## Stage 6 — Present  [GATE 2]

Present: the diff summary, the review and verify results (honestly — include any failures), and any downstream-consumer handoff note. Then **stop.** The user commits and pushes; do not run any git write command.
