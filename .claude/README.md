# Claude Engineering Framework

Team-shared Claude Code assets for this NestJS + Prisma starter, versioned and
adopted as a unit.

**The framework** is `.claude/`, `CLAUDE.md`, `scripts/validate-claude-config.ts`,
and `docs/adr/`. **The starter repository** is the whole NestJS API that ships
it. The two move at different speeds and are upgraded differently, which is why
they have different names — see `.claude/ADOPTING.md`.

This directory contains:

- an orchestrated **work-item-to-validated-diff** workflow;
- independently invocable engineering gates;
- project-aware specialist agents;
- ADR, threat-model, API, database, and release templates;
- deeper architecture, coding, security, and testing standards;
- harness-enforced safety hooks.

This is developer tooling, not part of the API. The API builds, runs, and tests
without it. Developers who do not use Claude Code can ignore this directory.

**Framework version: `.claude/VERSION`.** What each version contains is in
`.claude/CHANGELOG.md`; how to adopt the framework into a new project, upgrade an
existing one, or back-port a fix found downstream is `.claude/ADOPTING.md`. It is
copied rather than installed, so the version is the only thing that tells an
adopted project what it has — and the adoption checks in `yarn claude:validate`
stay quiet until `package.json` is renamed, then fail until the copy actually
describes *your* repository.

## Recommended workflows

There are two supported ways to work.

### Continuous pipeline

Use this to drive work from repository research through a reviewed and validated
working-tree diff **in one session**, stopping only at the two human gates:

```text
/work-item IA-123
/work-item <pasted requirement>
/work-item add rate limiting to the OTP resend endpoint
```

**An issue key is not required.** The argument may be an issue key, an issue URL
(the key is extracted from it), or the requirement written out in plain words —
all three are first-class. A URL that yields no key stops with a message rather
than being mistaken for the requirement text.

`/work-item` is the top-level conductor. It maintains pipeline state in the main
conversation, delegates read-only research/review agents, stops for design
approval, implements only the accepted ADR, reviews and validates the diff,
presents the result, and optionally posts one issue comment.

### Individual engineering gates

Use these for non-ticket work, focused operation, recovery in a new session, or
when you deliberately want to control each stage yourself:

```text
/gate-design <requirement | ADR path to resume>
/gate-approve <ADR path>
/gate-implement <accepted ADR path>
/gate-review [ADR path or base ref]
/gate-validate [ADR path or scope]
```

The phase skills are human-invoked. `/work-item` does not recursively invoke them
through the Skill tool. Instead, it reads their `SKILL.md` files as the
authoritative stage contracts and performs those stages in the main
conversation. This preserves human invocation controls while preventing the
orchestrator and the standalone gates from drifting apart.

Each standalone gate ends by naming the next command with its argument filled in
and offering to continue in the same session — the contract is
`standards/gate-handoff.md`, referenced by all five rather than restated in
each. Continuing carries authorisation for the **next gate only**. Running the
gates individually and answering "yes" at each handoff reaches the same place as
`/work-item`; the difference is that you decide at every boundary, and can drop into
a fresh session whenever independence matters more than momentum.

## Work-item-to-validated-diff pipeline

| Stage | What runs | Human boundary |
|---|---|---|
| 1. Understand | `context-mapper`; additional architect, security, API, database, performance, or test agents when relevant | |
| 2. Design | The `gate-design` skill contract, ticket-vs-code reconciliation, alternatives, threat model, and `PROPOSED` ADR | **GATE 1:** no source edit until explicit approval |
| 3. Implement | The `gate-implement` skill contract and the accepted ADR | |
| 4. Review | Project-aware architecture, correctness, security, test, API, database, and performance agents; bundled `/security-review` or `/simplify` when useful and available | No unresolved Critical/High finding |
| 5. Validate | The `gate-validate` skill contract, `yarn build`, `yarn lint`, affected tests, database/security evidence, and `/run` for a runnable surface | `PASS`, `FAIL`, or `BLOCKED` only |
| 6. Present | Diff summary, review findings, evidence, risks, and consumer handoff | **GATE 2:** human owns commit, push, PR, migration application, and deployment |
| 7. Report | One short issue comment when a real issue and tracker connection exist | Issue status and fields remain untouched |

The conductor creates a seven-stage task checklist before Stage 1 and keeps
exactly one stage in progress. The checklist is the session's durable workflow
memory across long design discussion and context compaction.

The accepted ADR is the durable repository artifact. If a session is lost,
resume with the individual skills according to ADR state:

```text
DRAFT     → /gate-design <ADR>      (resume; never restart)
PROPOSED  → /gate-approve <ADR>
ACCEPTED  → /gate-implement <ADR>
implemented diff → /gate-review <ADR>
reviewed diff    → /gate-validate <ADR>
```

## Work-item interpretation

A work item is a claim to validate, not a specification to transcribe.

The pipeline separates:

- **WHAT:** the product outcome and acceptance criteria;
- **HOW:** the method the ticket happened to suggest.

Stage 1 verifies factual claims against the source. Stage 2 recommends the
approach supported by repository evidence and records rejected alternatives.
Stale or unsafe technical prescriptions are not implemented merely because they
appear in the work item.

Genuine product choices go back to the human.

## Components

### Skills

- `skills/work-item/SKILL.md` — full conductor.
- `skills/gate-design/SKILL.md` — repository mapping, risk, alternatives, threat
  model, and the ADR. Pass an ADR path instead of a requirement to resume a
  `DRAFT` left by an earlier session or another developer.
- `skills/gate-approve/SKILL.md` — reads a `PROPOSED` ADR back to the human,
  takes an explicit decision, and records it.
- `skills/gate-implement/SKILL.md` — accepted-ADR implementation.
- `skills/gate-review/SKILL.md` — independent project-specific review and
  remediation.
- `skills/gate-validate/SKILL.md` — read-only evidence gate.

All six workflow skills use `disable-model-invocation: true`; only the human
starts them. That flag removes the skill from Claude's context entirely, so
Claude cannot invoke a gate even when instructed to — it must **stop and ask the
user** to run the next one. `CLAUDE.md` states this obligation explicitly so the
gate is never simulated from memory.

### Why the gates carry a `gate-` prefix

Every user-invocable project skill is namespaced `gate-*`. This is a structural
rule, not a stylistic one.

Claude Code ships built-in commands and adds more over time, and a project skill
that takes the same name does not cleanly win — it simply appears *beside* the
built-in in the `/` menu, disambiguated only by which row you land on. This has
already happened twice here: `review` collided with the bundled diff-review
skill, and `design` collided with `/design` ("Grant or revoke Claude agent access
to your Design projects"), which also sits next to `/desktop` under the same
prefix. Selecting the wrong row runs something entirely unrelated.

Maintaining a list of reserved built-in names does not fix this — such a list is
stale the moment Anthropic ships a new command, and the list itself is what
failed to catch `design`. A prefix removes the whole collision class instead:
Anthropic will not ship a `/gate-*` command. It also groups the workflow in the
menu, so typing `/gate` shows exactly these five and nothing else.

`yarn claude:validate` enforces the prefix, so a new gate cannot be added
without it.

The five domain playbook skills below need no prefix: they set
`user-invocable: false` and never appear in the `/` menu at all, so they have no
collision surface there.

`/work-item` is deliberately exempt — it is the conductor, not a gate, so a
`gate-` name would misdescribe it. The exemption is also safer than it looks:
Claude Code's built-ins are single words (`init`, `review`, `design`, `run`,
`debug`), so a hyphenated compound has a much smaller collision surface than a
bare noun like `ticket` did. The validator still records it as an explicit,
reviewed exemption rather than letting it pass unnoticed.

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
- `standards/gate-handoff.md` — how every gate closes and hands off.

### Hooks and validation

- `hooks/guard-dangerous-commands.sh` — resolves the effective verb of every
  subcommand and blocks human-owned operations a prefix rule cannot see.
- `hooks/guard-protected-paths.sh` — path-specific `ask` with the precondition
  that path requires.
- `hooks/format-changed-file.sh` — formats the single file just edited.
- `../scripts/validate-claude-config.ts` — the guardrail for this directory,
  run by `yarn claude:validate` and in CI.

### Where ADRs live

`docs/adr/NNNN-kebab-slug.md`, committed, from `templates/adr.md`. See
`docs/adr/README.md` for the lifecycle. Every gate after design takes an ADR path,
and a resumed session finds its place by reading the `Status:` line — which only
works because the location is fixed rather than chosen per session.

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
- `/run` for actual runtime exercise (`/verify` is a bundled skill on some
  installations only — check `/skills` before relying on it).

Do not depend on a bundled command that is unavailable on a developer's Claude
Code version or plan. The project review and validation skills remain complete
without it.

## Issue-tracker behavior

When `/work-item` receives a real issue key and the configured tracker MCP is
connected, it may:

- read the issue during Stage 1;
- post exactly one completion/blocker comment during Stage 7.

Invoking `/work-item <issue key or URL>` is standing authorization for that one comment.

It must never (each is enforced by a `permissions.deny` rule, not just prose):

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

`.claude/settings.json` is enforcement, not reminders — and it is committed, so
every developer inherits the same floor. Three mechanisms, each with a distinct
job:

**1. `permissions.deny` — the hard floor.** Declarative, evaluated before every
hook, and impossible to fail open. This is where `CLAUDE.md`'s *Human-owned
operations* list is made real, **for the exact command forms it names**:

- git history and publication writes (`commit`, `push`, `merge`, `rebase`,
  `tag`, `reset`, `clean`, `stash`, `checkout`, `cherry-pick`, `revert`, …);
- `gh pr create|merge|close|edit|ready|review`, `gh release`, `gh workflow run`;
- every migration application and database reset (`prisma migrate`, `prisma db
  push`, `yarn prisma:migrate|deploy|reset|seed`);
- volume destruction (`docker compose down`, `docker volume rm|prune`) — use
  `yarn stack:down`, which is allowed and never passes `-v`;
- package publication and image push;
- **the Read and Edit tools** against real environment files and private keys.
  `.env.test` and `.env.example` stay readable — `/gate-validate` needs them.
  A `Read(.env)` rule governs the Read *tool*; it says nothing about `cat .env`,
  which is layer 3's job;
- issue-tracker transition, field-edit, update, delete, and assignment tools.

Every Bash rule is mirrored as a `PowerShell(...)` rule. The PowerShell tool is
enabled by default on Windows without Git Bash, and `Bash(...)` rules do not
govern it — an unmirrored floor simply disappears on those machines, with no
warning anywhere. `yarn claude:validate` fails when the two lists diverge.

MCP rules use a **glob server segment** — `mcp__*__transitionJiraIssue`, never
`mcp__atlassian__…`. A tool is named `mcp__<server>__<tool>`, and `<server>` is
whatever the adopting project called it in `.mcp.json`; a hardcoded name matches
nothing in a project that named its server differently, so the tracker floor is
absent while this document still promises it. Deny and ask rules accept a glob
there (only *allow* rules require a literal server). The validator enforces it.
Tool *names* still need one check per tracker: run `/mcp`, list the server's
tools, and confirm the write verbs are covered.

**2. `permissions.ask` — dual-use commands needing human judgment.** `psql`,
`pg_dump`, `redis-cli`, `docker exec`, `gh api` (read or write depending on its
method), `git branch|worktree` (list or delete), and issue creation.

**3. Hooks — the layer that sees what a prefix rule cannot.** A `permissions`
rule matches a command *prefix*, so it is structurally blind to the same
operation written any other way:

```text
git -C /elsewhere commit -m x            flag before the verb
dotenv -e .env -- prisma migrate deploy  environment runner (docs: not stripped)
sudo npm publish                         privilege wrapper
cat .env                                 the shell, not the Read tool
```

Hooks also teach: a deny rule gives an anonymous refusal, a hook explains the
precondition. All three live in `.claude/hooks/` as real scripts — `set -euo
pipefail`, syntax-checked and behaviour-tested in CI, and **fail closed**: an
unavailable `jq` degrades to a prompt, never to silent approval.

- `guard-dangerous-commands.sh` — parses every subcommand of a Bash or
  PowerShell call, resolves the effective verb behind wrappers and runners, and
  denies human-owned operations, credential reads, and unrecoverable removals.
  Its git verb table is kept in lockstep with the deny rules by the validator;
- `guard-protected-paths.sh` — `ask` before editing `prisma/migrations/**`,
  `prisma/schema.prisma`, auth/authorization surfaces, or the error contract,
  each with the specific precondition that path requires;
- `format-changed-file.sh` — formats and auto-fixes the single `.ts` file just
  edited, so lint stays green continuously.

**None of this is a sandbox, and it must not be described as one.** A shell can
always express an operation the parser does not model — a verb built from a
variable, an operation inside a script file, a here-doc. Layer 1 cannot fail
open but only sees the forms it names; layer 3 sees far more forms but is
executable code that can fail. They are complementary, and neither is a
boundary. For a real boundary use OS sandboxing or a container.

Precedence is `deny` → `ask` → `allow`, first match wins, and a deny rule cannot
carry an exception. Deny rules in this file override any allow rule a developer
adds in their own `settings.local.json`. A `PreToolUse` hook cannot loosen them
either: Claude Code evaluates deny and ask rules regardless of what a hook
returns.

> **Note on file rules:** Claude Code checks file permissions against `Edit()`
> and `Read()` only. A `Write(...)`, `NotebookEdit(...)`, `MultiEdit(...)` or
> `Glob(...)` path rule is accepted, never consulted, and warns at startup —
> the worst failure shape available, because the file reads as protected. Use
> `Edit(...)` and `Read(...)`. The validator rejects the inert forms in all
> three tiers.

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

## Validating this directory

```text
yarn claude:validate
```

`.claude/` is several thousand lines of frontmatter and cross-references that
fail *silently*: a mistyped key is ignored, a renamed symbol leaves a skill
quoting code that no longer exists, and a skill whose name collides with a
bundled command resolves unpredictably. `CLAUDE.md` requires every convention to
ship with a guardrail; this is the tooling's own.

`scripts/validate-claude-config.ts` checks frontmatter against the documented
schema, skill/agent name agreement, collisions with built-in commands, the
1,536-character skill-listing cap, cross-reference resolution, and doc-vs-code
symbol drift.

It also enforces the guardrails above, each of which was a real defect here
before it was a check:

- every agent is read-only, judged by its **effective tool pool** rather than by
  a phrase in its prose. The earlier probe searched for the sentence "Never edit
  files", so it passed the three agents that had neither the sentence nor the
  restriction — silence read as compliance. A check that cannot catch an
  omission is not a check;
- the required deny floor is present, so deleting one line cannot quietly
  retract a promise that `CLAUDE.md` still makes;
- `Bash` and `PowerShell` deny/ask rules stay mirrored;
- MCP rules use a glob server segment, so the tracker floor survives being
  copied into a project that named its server differently;
- the guard hook's git verb table matches the deny rules;
- dead `Write()`/`Glob()`/`NotebookEdit()`/`MultiEdit()` path rules in any tier;
- hook scripts exist, parse, are executable, and are actually referenced by
  `settings.json` — an unwired script still reads as an active guard;
- **the guard hook decides correctly**, against a fixture table of about forty
  commands. `bash -n` and `chmod +x` prove a hook runs, not that it is right,
  and a hook that crashes exits non-zero, which Claude Code treats as a
  non-blocking error — so a broken guard fails *open*. The table covers the
  wrapper and flag-bearing forms, the parser regressions found while writing it,
  and ordinary commands such as `yarn build` that must never prompt: a guard
  that nags gets switched off within a day, and then it protects nothing.

It runs in CI beside `yarn lint`.

Restart Claude Code after adding or replacing skills and agents.

## Deferred

An isolated worktree implementation fan-out is intentionally deferred.

Add it only when a change can be decomposed into independent edits with clear
ownership and merge boundaries. The main conductor must coordinate the
subagents; subagents do not recursively spawn other subagents.
