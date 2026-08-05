# Claude Code tooling

Team-shared Claude Code assets for this NestJS + Prisma starter.

This directory contains:

- an orchestrated **ticket-to-validated-diff** workflow;
- independently invocable engineering gates;
- project-aware specialist agents;
- ADR, threat-model, API, database, and release templates;
- deeper architecture, coding, security, and testing standards;
- harness-enforced safety hooks.

This is developer tooling, not part of the API. The API builds, runs, and tests
without it. Developers who do not use Claude Code can ignore this directory.

## Recommended workflows

There are two supported ways to work.

### Full ticket pipeline

Use this for a Jira ticket or pasted ticket that should be driven from
repository research through a reviewed and validated working-tree diff:

```text
/ticket IA-123
```

or:

```text
/ticket <pasted ticket text>
```

`/ticket` is the top-level conductor. It maintains pipeline state in the main
conversation, delegates read-only research/review agents, stops for design
approval, implements only the accepted ADR, reviews and validates the diff,
presents the result, and optionally posts one issue comment.

### Individual engineering gates

Use these for non-ticket work, focused operation, recovery in a new session, or
when you deliberately want to control each stage yourself:

```text
/design <requirement>
/implement <accepted ADR path>
/review [ADR path or base ref]
/validate [ADR path or scope]
```

The phase skills are human-invoked. `/ticket` does not recursively invoke them
through the Skill tool. Instead, it reads their `SKILL.md` files as the
authoritative stage contracts and performs those stages in the main
conversation. This preserves human invocation controls while preventing the
orchestrator and the standalone gates from drifting apart.

## Ticket-to-validated-diff pipeline

| Stage | What runs | Human boundary |
|---|---|---|
| 1. Understand | `context-mapper`; additional architect, security, API, database, performance, or test agents when relevant | |
| 2. Design | The `design` skill contract, ticket-vs-code reconciliation, alternatives, threat model, and `PROPOSED` ADR | **GATE 1:** no source edit until explicit approval |
| 3. Implement | The `implement` skill contract and the accepted ADR | |
| 4. Review | Project-aware architecture, correctness, security, test, API, database, and performance agents; bundled `/security-review` or `/simplify` when useful and available | No unresolved Critical/High finding |
| 5. Validate | The `validate` skill contract, `yarn build`, `yarn lint`, affected tests, database/security evidence, and `/verify` for a runnable surface | `PASS`, `FAIL`, or `BLOCKED` only |
| 6. Present | Diff summary, review findings, evidence, risks, and consumer handoff | **GATE 2:** human owns commit, push, PR, migration application, and deployment |
| 7. Report | One short issue comment when a real issue and tracker connection exist | Issue status and fields remain untouched |

The conductor creates a seven-stage task checklist before Stage 1 and keeps
exactly one stage in progress. The checklist is the session's durable workflow
memory across long design discussion and context compaction.

The accepted ADR is the durable repository artifact. If a session is lost,
resume with the individual skills according to ADR state:

```text
PROPOSED  → /design or continue the approval discussion
ACCEPTED  → /implement <ADR>
implemented diff → /review <ADR>
reviewed diff    → /validate <ADR>
```

## Ticket interpretation

A ticket is a claim to validate, not a specification to transcribe.

The pipeline separates:

- **WHAT:** the product outcome and acceptance criteria;
- **HOW:** the method the ticket happened to suggest.

Stage 1 verifies factual claims against the source. Stage 2 recommends the
approach supported by repository evidence and records rejected alternatives.
Stale or unsafe technical prescriptions are not implemented merely because they
appear in the ticket.

Genuine product choices go back to the human.

## Components

### Skills

- `skills/ticket/SKILL.md` — full conductor.
- `skills/design/SKILL.md` — repository mapping, risk, alternatives, threat
  model, ADR, and approval.
- `skills/implement/SKILL.md` — accepted-ADR implementation.
- `skills/review/SKILL.md` — independent project-specific review and
  remediation.
- `skills/validate/SKILL.md` — read-only evidence gate.

All five workflow skills use `disable-model-invocation: true`; only the human
starts them.

### Agents

- `context-mapper` — blast-radius and ticket-vs-code map.
- `architect` — boundaries, ADR conformance, compatibility, and rollout.
- `security` — JWT, RBAC/CASL, tenant scope, abuse, audit, and data exposure.
- `reviewer` — correctness and maintainability.
- `tester` — risk-based unit/e2e and evidence quality.
- `api` — DTO, error, Swagger, event, and consumer contracts.
- `database` — Prisma/PostgreSQL models, constraints, queries, and migrations.
- `performance` — HTTP/worker reliability, queues, retries, and resource bounds.

Agents are read-only. The main conversation verifies findings and owns any
approved remediation.


### Domain playbook skills

These are automatically selected background skills and are hidden from the
slash-command menu:

- `auth-security` — registration, login, JWT/session, OTP, recovery, lockout,
  anti-enumeration, throttling, and audit.
- `authorization` — permissions, roles, CASL abilities, PLATFORM/BUSINESS scope,
  ownership, query-level tenant isolation, escalation, and cache invalidation.
- `e2e-testing` — real PostgreSQL/Redis harness, worker isolation, contract
  assertions, queue/scheduled tests, and evidence cadence.
- `resource-pattern` — canonical model/controller/service/DTO/Swagger/lifecycle/
  migration/e2e resource implementation.
- `scheduled-sweep` — recurring due-row/reconciliation sweeps only; BullMQ
  remains the default for per-record delayed, retryable, cancellable, or
  reschedulable work.

### Templates

- `templates/adr.md`
- `templates/threat-model.md`
- `templates/api-contract.md`
- `templates/database-design.md`
- `templates/release-checklist.md`

### Standards

- `standards/architecture.md`
- `standards/coding.md`
- `standards/security.md`
- `standards/testing.md`

`CLAUDE.md` is the always-on project constitution. Repository-specific rules in
`CLAUDE.md`, source-owned contract READMEs, and accepted ADRs take precedence
over generic guidance.

## Review engines

The project agents are the required review mechanism because they understand
this repository's exact contracts.

Bundled Claude Code skills may supplement them:

- `/security-review` for an additional read-only security pass;
- `/simplify` after correctness/security findings are resolved, with every
  proposed change verified against the ADR and project standards;
- `/verify` or `/run` for actual runtime exercise.

Do not depend on a bundled command that is unavailable on a developer's Claude
Code version or plan. The project review and validation skills remain complete
without it.

## Issue-tracker behavior

When `/ticket` receives a real issue key and the configured tracker MCP is
connected, it may:

- read the issue during Stage 1;
- post exactly one completion/blocker comment during Stage 7.

Invoking `/ticket <ISSUE-KEY>` is standing authorization for that one comment.

It must never:

- transition the issue;
- edit fields, status, assignee, priority, or sprint;
- claim code is committed, pushed, merged, released, or deployed;
- create a related/blocker issue unless the user separately asks.

The Stage 7 comment is written for the reporter, QA, and standup—not for the
developer reviewing the diff. It answers:

1. what behavior changed;
2. what changed beyond the ticket;
3. what remains blocked.

No file paths, function names, or internal error codes belong in the comment.

## Guardrails

Project hooks in `.claude/settings.json` are enforcement, not reminders.

Recommended enforced boundaries:

- deny `git commit`, `git push`, force-push, and other publication writes;
- deny issue transition and field-edit MCP operations;
- ask before editing `prisma/migrations/**`;
- deny destructive database/reset commands;
- protect secrets and environment files;
- optionally block deployment and package publication commands.

Review hook implementations when Claude Code or MCP tool names change.

## Issue tracker setup

The repository may commit `.mcp.json` with a tracker server declaration. OAuth
credentials remain per developer.

For Atlassian:

1. Open the repository in Claude Code.
2. Approve the configured MCP server.
3. Run `/mcp`.
4. Select the project-specific Atlassian server.
5. Authenticate in the browser.

If no tracker is connected, paste the ticket text. Stages 1–6 still run and
Stage 7 is skipped.

Use a project-specific MCP server name so OAuth state does not accidentally
cross projects.

## Migration from the legacy command

The old file:

```text
.claude/commands/ticket.md
```

still works as a legacy custom command, but it should be removed after installing:

```text
.claude/skills/ticket/SKILL.md
```

Do not keep both with the same `/ticket` name. Skills are the current format and
support invocation controls and supporting files.

Restart Claude Code after adding or replacing skills and agents.

## Deferred

An isolated worktree implementation fan-out is intentionally deferred.

Add it only when a change can be decomposed into independent edits with clear
ownership and merge boundaries. The main conductor must coordinate the
subagents; subagents do not recursively spawn other subagents.
