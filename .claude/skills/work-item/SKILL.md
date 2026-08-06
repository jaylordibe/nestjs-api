---
name: work-item
description: Drives a tracked work item or pasted requirement through repository mapping, an approval-gated ADR, implementation, independent project-specific review, read-only validation, presentation, and at most one issue-tracker comment.
argument-hint: "<issue key | issue URL | pasted requirement>"
disable-model-invocation: true
model: inherit
effort: high
---

# Work-item conductor

Work item:

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

Invoking `/work-item <real issue key or URL>` authorizes exactly one Stage 7
issue comment when the configured tracker is connected. It does not authorize any
other issue write. A pasted-requirement invocation authorizes none.

## Autonomy contract

**This pipeline runs to completion on its own.** Invoking `/work-item` is the
authorisation for the whole sequence; the human is interrupted exactly twice:

| Stop | Stage | Why it cannot be automated |
|---|---|---|
| **ADR approval** | 2 | `gate-approve` sets `disable-model-invocation: true`. A design must not approve itself. |
| **Present, then human review and push** | 6 | Git writes are denied. The commit is the human's act of record. |

Everything between those two runs without asking. You are operating the gate
skills in **conductor mode** — `.claude/standards/gate-handoff.md` §0 and §5 —
so when a gate's own `SKILL.md` ends by offering to continue, recommending a
fresh session, or printing the next `/gate-*` command, **that instruction is
addressed to a human who typed that command directly, and does not apply here.**
Emit the stage marker and proceed.

Removing the prompts removes no rigor. Every subagent panel still fans out at
full width for the risk tier, every check still runs, and every stop condition
below still stops. On **High or Critical** work, Stage 4 must fan out to
independent read-only subagents and run the adversarial refutation pass — that
is what preserves review independence now that no human checkpoint sits between
writing the diff and reviewing it. A conductor that reviews High/Critical work
by itself has skipped the gate, not accelerated it.

Stop mid-pipeline **only** for:

- a material divergence from the accepted ADR — propose an amendment and return
  to the approval gate;
- an unresolved product decision that reading the repository cannot settle;
- two complete remediation cycles exhausted with findings still unresolved;
- a Stage 5 `FAIL` or `BLOCKED` that Stage 3 or 4 cannot fix within the accepted
  ADR;
- a missing prerequisite — an unavailable service, absent credential, or a check
  that cannot run.

Name which one fired and what it blocks. Never stop to confirm a stage that had
no such problem, and never ask the human to authorise a step they already
authorised by invoking this skill.

## Normative stage playbooks

Each stage below is governed by a gate skill. **Read that skill's `SKILL.md` when
you enter its stage — not now.** The five gate skills total over a thousand
lines; front-loading all of them spends the context this pipeline needs for the
actual diff, and four of the five would be read long before they are relevant.
Loading on demand is the entire reason the gates are separate files.

Do **not** read `CLAUDE.md` as a step: it is the always-on project constitution
and is already in context on every request. Re-reading it is a wasted call.

Read alongside a stage, when that stage's work touches them:

- the relevant `.claude/standards/` document;
- the source-owned contract README for the area being changed.

The five gate skills are human-only and must not be recursively invoked through
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

`$ARGUMENTS` arrives in one of three forms. Classify it **before** doing anything
else — misclassifying a URL as requirement text means designing against a link.

**1. An issue key** (`IA-123`) — an uppercase project prefix, a hyphen, digits.

**2. An issue URL.** Extract the key by pattern rather than by matching known
hosts: pull the first `KEY-123`-shaped token out of the path or query string.
This resolves a plain browse link and a board link carrying the issue as a query
parameter with the same rule, and keeps working for any tracker that uses the
same key format — no host list to maintain.

```text
https://<host>/browse/IA-123                          -> IA-123
https://<host>/jira/software/projects/IA/boards/1?selectedIssue=IA-123  -> IA-123
```

**3. Pasted requirement text** — anything else. This is a first-class input, not
a fallback: `/work-item add rate limiting to the OTP resend endpoint` is a
supported and common invocation. No issue key exists, so Stage 7 is skipped.

### After classifying

For form 1 or 2, when the configured issue-tracker MCP is available:

- fetch summary, description, acceptance criteria, and any comments or linked
  context needed to understand the request;
- record the resolved key for Stage 7.

If a key was resolved but the tracker is **not** connected, say so, and ask the
user to paste the item's content rather than proceeding on the key alone — a key
is an identifier, not a requirement.

**If `$ARGUMENTS` looks like a URL but yields no key, stop and say so.** Do not
fall through to treating the URL as the requirement: that silently designs
against a link. Ask for the key or the pasted content.

Ask for missing detail only when neither source provides enough product intent to
design safely.

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

Read `.claude/skills/gate-design/SKILL.md` now, and follow it.

Enter Plan mode when available. Remain read-only even if Plan mode is
unavailable.

**Classify the risk tier first — it decides whether this stage produces an ADR
at all.** `gate-design` §4 holds the table. A **Low** risk change gets no ADR:
state the tier and the evidence, present the approach in the normal Plan/approval
interface, and on approval go straight to Stage 3. Stages 4–7 still run in full.
Everything Medium and above gets an ADR whose depth matches the tier.

For an ADR, use `.claude/templates/adr.md` with:

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

## Presenting for approval

This is one of the pipeline's two human stops, so make the decision **one
action**, not a typed command.

Call `ExitPlanMode` with the read-back below as the plan. The user gets an
approve/reject control, and an affirmative click **is** the explicit decision
this gate requires — record it and continue in the same turn. Do not tell them
to run `/gate-approve`: that command exists for an ADR designed in an earlier
session, and routing a live pipeline through it turns one click into a typed
command plus a second reading of a document they just read.

The read-back is not the ADR pasted back. It is, concisely and in your own
words: the recommendation; the trade-off accepted by rejecting the alternatives;
contract and data impact; residual security and privacy risk; the
rollback path; **what this deliberately does NOT do**; and **every unresolved
§14 row, individually**. Scope disappointment surfaces at the non-goals more
often than any technical objection does, which is why they are read back rather
than left in the file.

If §14 has an unresolved row, the user must resolve it or accept it as a stated
condition. Put that question in the plan, and record verbatim what they accept.

Approval must be unambiguous. A click approves. Ambiguous praise in passing —
"nice", "ok" while discussing something else — does not, in either direction. If
`ExitPlanMode` is unavailable, fall back to `AskUserQuestion`; never infer a
decision from prose that was not a decision.

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

Read `.claude/skills/gate-implement/SKILL.md` now, and follow it together with
the accepted ADR — except for its closing handoff, which is written for a human
who typed `/gate-implement`. Its fresh-session recommendation does not apply
here; see the autonomy contract above.

Before editing:

- inspect Git status/diff;
- preserve unrelated changes;
- confirm repository reality still matches the ADR.

Implement coherent slices with tests.

The contracts to enforce are `CLAUDE.md`'s *Cross-cutting conventions* and the
relevant `.claude/standards/` document. `gate-implement` carries the checklist of
lenses and names the authoritative source for each; neither it nor this file
restates the contracts themselves, because a second copy drifts and nothing can
detect that it has. Work from the source, never from a summary.

Run focused checks after coherent slices.

If a material ADR divergence becomes necessary, stop Stage 3, propose an ADR
amendment, and return to the approval gate.

When the accepted implementation and focused tests are complete, mark Stage 3
complete, emit the stage marker, and **begin Stage 4 immediately**. Do not ask
whether to proceed.

# Stage 4 — Review

Read `.claude/skills/gate-review/SKILL.md` now, and follow it. It selects the
review lenses by risk tier; do not fan out the full panel by default.

The lenses available to it:

- `architect`
- `reviewer`
- `security`
- `tester`
- `api`
- `database`
- `performance`

Verify every candidate finding before reporting or fixing it, and adversarially
refute Critical/High findings on High/Critical work — the gate defines both.

On High or Critical work this fan-out is **mandatory, not tier-suggested**: the
subagents are the only independent readers of this diff, because no human
checkpoint separates writing it from reviewing it. Each starts from a clean
context and reads the diff from disk. Never substitute your own reading of code
you just wrote.

Remediate verified findings within accepted scope, add regression tests, run
focused checks, and re-run affected reviewers.

Perform at most two complete remediation/re-review cycles.

Stage 4 exits only when:

- no unresolved Critical or High finding remains;
- any unresolved Medium/risk is plainly documented and requires human/product
  action;
- review fixes have focused test evidence.

Mark Stage 4 complete, emit the stage marker, and **begin Stage 5 immediately**.

# Stage 5 — Validate

Read `.claude/skills/gate-validate/SKILL.md` now, and follow it.

Validation is read-only. That constraint is about *evidence*: never edit source,
tests, snapshots, or configuration to manufacture a pass. It is not a reason to
stop and hand the user a block of text to copy — see the §16 filing rule at the
end of Stage 5.

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

## Filing the validation record

`gate-validate` §10 emits the §16 evidence block and tells the user to paste it,
because that skill runs with Edit and Write removed. **In conductor mode, write
it into the ADR yourself** — you are not running under those restrictions, and
handing the human a copy-paste chore at the end of an autonomous pipeline is the
manual step this design exists to remove.

The record stays trustworthy because of where it lands, not who typed it: §16
goes into a file the human reads in the Stage 6 diff and commits by hand. A
verdict they never see is the problem; a verdict they read before pushing is the
control.

Two limits still bind:

- write **only** §16 of the ADR — nothing else in it, and no source, test,
  snapshot, or configuration file. The read-only rule is about not manufacturing
  a pass, and it is absolute.
- file the verdict **exactly as it came out**, including `FAIL` or `BLOCKED`
  with the gate that produced it. A validation record that only ever says `PASS`
  records nothing.

Skip this when the change is Low risk and has no ADR. Say so in one line.

Mark Stage 5 complete only when the evidence report is complete, even if the
verdict is FAIL or BLOCKED, then continue to Stage 6.

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
original `/work-item <issue key or URL>` invocation authorized this single
comment.

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
