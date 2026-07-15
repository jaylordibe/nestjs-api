---
description: Drive a ticket from context-gathering to a verified diff, stopping at the plan-approval and commit gates, then report back on the ticket.
argument-hint: <TICKET-KEY | pasted ticket text>
---

You are the **conductor** for the ticket-to-diff pipeline. Follow these stages in order. Three rules are non-negotiable: **never implement before the plan is approved**, **never commit or push** (the human owns all git writes — a project hook enforces this), and **never transition an issue or change its fields** (the human moves the board columns after they push).

## Track pipeline state (do this first)

Before Stage 1, create a persistent todo checklist with all seven stages as items:
`1. Understand` · `2. Plan [GATE 1]` · `3. Implement` · `4. Review` · `5. Verify` · `6. Present [GATE 2]` · `7. Report to the issue tracker`.
Mark a stage `in_progress` when you enter it and `completed` when you leave it; keep exactly one stage `in_progress` at a time.

This checklist is the pipeline's **durable memory**. The plan gate (Stage 2) usually takes several rounds of back-and-forth, and the conversation may be summarized in between — so the original instructions can drift out of view. The checklist survives that. Therefore:

- Keep Stage 2 `in_progress` through the entire plan discussion; do not mark it completed until the user **approves** the plan.
- **When approval arrives, re-read the checklist and resume at the next pending stage (Stage 3 — Implement), then continue through Review → Verify → Present → Report.** Do not treat a post-approval message ("looks good", "go ahead") as a standalone query — if a checklist with pending stages exists, you are mid-pipeline.
- Never skip Stages 4–7 just because approval came after a long discussion.

## Input

Ticket: $ARGUMENTS

If `$ARGUMENTS` is an issue key and an issue-tracker MCP (e.g. Atlassian/Jira) is connected, fetch the issue (summary, description, acceptance criteria). Otherwise treat `$ARGUMENTS` as the ticket content. If neither gives you enough to act on, ask for the ticket details before proceeding.

## Stage 1 — Understand (parallel, read-only)

Launch the `context-mapper` agent on the ticket to produce the impact map (touched files, contract surface, security surface, downstream consumers, tests implied). For a large or cross-cutting ticket, launch several `context-mapper` agents scoped to different subsystems in parallel. Read the map fully before designing anything.

Treat the ticket as a **claim, not a spec**. The map must include a **ticket-vs-reality reconciliation**: which of the ticket's factual assertions the source confirms, which are stale or incorrect (cite `path:line`), and whether the approach the ticket prescribes is sound, suboptimal, inapplicable, or bad practice given the code. Separate the outcome the ticket wants (the WHAT) from the method it happens to name (the HOW) — the method is one candidate, not a mandate. If the reconciliation contradicts the ticket, that feeds the plan; do not implement a prescription the code has outgrown.

## Stage 2 — Plan  [GATE 1]

Enter **Plan mode**. Produce an ADR per CLAUDE.md: Context → Approach (rationale + rejected alternatives) → file-by-file changes → tests → verification → what this deliberately does NOT do. Then **stop and present it via ExitPlanMode**. Do not edit any file until the user approves. A plan is not a green light.

The ADR **recommends, it does not transcribe**. Propose the approach *you* judge best on the evidence from Stage 1 — not merely the one the ticket named. When your approach departs from a method the ticket prescribed, lead with your recommendation and its rationale, and put the prescribed approach under rejected alternatives with the trade-off that ruled it out. If the Stage 1 reconciliation found the ticket resting on a stale or incorrect premise, surface that in Context so the human can weigh it. Where the divergence is genuinely a product decision rather than a technical one, call it out and let the human decide rather than quietly choosing.

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

Present: the diff summary, the review and verify results (honestly — include any failures), and any downstream-consumer handoff note. Do **not** run any git write command — the user commits and pushes. Then continue to Stage 7.

## Stage 7 — Report to the issue tracker

Post a single comment on the issue (Jira: `addCommentToJiraIssue` with `contentFormat: "markdown"`). No approval round-trip needed — the user has standing authorization for this one write. Skip this stage when no issue-tracker MCP is connected, when the input was pasted free text rather than a real issue key, or when the work was abandoned.

**Never** transition the issue or edit its fields (Jira: `transitionJiraIssue`, `editJiraIssue`) — no status change, no assignee, no fields. The user moves the board columns themselves after they push. Never claim the work is merged, pushed, or deployed; at this point it exists only in their working tree.

The comment and the pull request have **different audiences**, and conflating them is the usual mistake. The PR carries the reasoning, the trade-offs, and the diff. The ticket comment is read by the reporter, QA, and whoever runs standup — so write it for a **non-technical reader** and keep it short. Answer exactly three questions:

1. **What behaviour changed**, in the language of the ticket — never the codebase. No file paths, no function names, no error codes.
2. **What changed beyond what was asked.** Any behaviour a tester would be surprised by belongs here — including latent bugs you fixed along the way. This is the highest-value part of the comment.
3. **What is still blocking**, explicitly. A ticket that reads "Done" while a cross-repo dependency is unshipped is how a broken feature reaches a real user. Say what must ship first and who owns it.

Lead with a one-line status (e.g. `**Implemented — ready for review.**`), and qualify it if anything is outstanding. If Stage 4 or 5 surfaced a failure you could not resolve, say so in the comment — do not quietly omit it.

A cross-repo blocker deserves its **own linked ticket**, not just a sentence in a comment; a comment is easy to miss, a linked blocker is not. You cannot create that ticket yourself unless the user asks — recommend it, and offer.

After posting, tell the user the comment went up and confirm the issue status is untouched.
