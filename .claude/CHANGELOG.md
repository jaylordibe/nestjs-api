# Claude Engineering Framework — changelog

The **Claude Engineering Framework** is this repository's Claude Code tooling:
`.claude/`, `CLAUDE.md`, `scripts/validate-claude-config.ts`, and `docs/adr/`.
It is versioned and copied into projects, separately from the starter repository
that ships it.

The version in `.claude/VERSION` identifies the framework a project adopted.
Without it, a copy is a snapshot with no way to tell what it contains or what it
is missing, and four projects diverge silently within a year — the exact drift
`CLAUDE.md` forbids in code.

`yarn claude:validate` fails when `VERSION` and the newest entry below disagree.

## Versioning

The number describes the **framework**, not the API it ships around, and not the
starter repository as a whole.

| Bump | Meaning | What an adopter must do |
|---|---|---|
| **MAJOR** | A change adopters must apply by hand — a renamed skill, a removed gate, a contract an existing project would now violate | Read the entry and edit their own files |
| **MINOR** | New capability, additive and safe to copy over | Copy the named files; nothing existing breaks |
| **PATCH** | Fixes and wording; no new obligations | Copy the named files |

Upgrade procedure and adoption checklist: `.claude/ADOPTING.md`.

## 1.1.0 — 2026-08-06

Additive and safe to copy over. Found by running `/work-item` on a real ticket in
an adopting project: the pipeline asked for four confirmations after the ADR was
approved, none of which decided anything.

### Two-mode gate handoff

`gate-handoff.md` had one closing protocol, written for a human typing
`/gate-implement` by hand: close, name the next command, ask whether to continue.
But `/work-item` Stages 3–5 execute those same gate skills as their playbooks, so
the conductor inherited that closing question at every stage boundary — plus a
fresh-session recommendation on High/Critical work. Approval itself handed back a
`/gate-approve` command to type rather than a decision the user could click.

`.claude/standards/gate-handoff.md` now establishes the invocation mode first:

- **Standalone** — a human typed the command. Behaviour unchanged.
- **Conductor** — a `/work-item` stage. Emit a one-line stage marker, keep going.

A `/work-item` run now stops exactly twice: **ADR approval**, presented through
`ExitPlanMode` so the decision is a click, and **Stage 6**, where the human
reviews the diff and pushes. Both are boundaries the pipeline cannot cross on its
own — `gate-approve` keeps `disable-model-invocation: true`, and Git writes stay
denied. §5 lists the five conditions that still stop a run mid-pipeline.

No rigor was traded for the autonomy. Every panel still fans out, every check
still runs. Two things tightened to keep it that way:

- **Review independence is now structural.** The fresh-session advice protected a
  real property: the reviewer should not be the context that just wrote the diff.
  Conductor mode makes the independent read-only subagent fan-out *mandatory* on
  High/Critical rather than tier-suggested; each subagent starts clean and reads
  the diff from disk.
- **An unresolved Critical or High finding still stops the work, in both modes.**
  That is the gate doing its job, not an inter-stage prompt.

`gate-validate` stays read-only and still only emits the §16 evidence block; in a
`/work-item` run the conductor files it into the ADR, so an autonomous pipeline
does not end with a copy-paste chore. The record is trustworthy because of where
it lands — a file the human reads in the Stage 6 diff and commits by hand — and
the verdict is filed exactly as produced, `FAIL` and `BLOCKED` included.

Guardrail: `validateHandoffModeContract` in `scripts/validate-claude-config.ts`
fails the build if `gate-handoff.md` loses either mode section, if any `gate-*`
skill's Handoff section stops distinguishing the two modes, or if `work-item`
loses its `## Autonomy contract`. Verified by deliberate breakage on all four
conditions. The split lives entirely in prose across seven files, so nothing else
would catch it drifting back to one mode.

**Adopters:** copy `.claude/standards/gate-handoff.md`, the six skills under
`.claude/skills/` (`work-item` and the five `gate-*`), and
`scripts/validate-claude-config.ts`. Then apply the `CLAUDE.md` changes by hand —
the *Ending a gate* section and the `/work-item` exception paragraph — since
`CLAUDE.md` is project-owned and cannot be copied wholesale.

## 1.0.0 — 2026-08-06

First versioned baseline. Copies taken before this are unversioned; diff them
against this tree wholesale rather than trying to identify what they contain.

**Workflow**

- `/work-item` conductor plus five human-invoked gates (`gate-design`,
  `gate-approve`, `gate-implement`, `gate-review`, `gate-validate`), each
  `disable-model-invocation: true` so a design cannot approve itself.
- Gate playbooks load **on entering their stage**, not up front. The conductor no
  longer front-loads ~1,000 lines of gate content, nor re-reads the always-on
  `CLAUDE.md`.
- **Risk tiering is binding.** The `CLAUDE.md` risk table now decides both the
  design artifact (Low gets no ADR at all) and the review panel size (Low:
  no subagents; Critical: full panel plus adversarial verification). A ceremony
  applied uniformly is a ceremony that gets skipped.
- **One contract source.** The gates name lenses and exit criteria and point at
  `CLAUDE.md` and `.claude/standards/`; they no longer restate contracts. This
  removed 148 duplicated contract bullets down to 17. A paraphrased checklist
  drifts from the rule it paraphrases and no tooling can detect it.

**Guardrails**

- `permissions.deny` floor for human-owned operations, mirrored for **Bash and
  PowerShell** — `Bash(...)` rules do not govern the PowerShell tool, which is
  on by default on Windows without Git Bash.
- MCP rules use a **glob server segment** (`mcp__*__…`), so the issue-tracker
  floor survives being copied into a project that named its server differently.
- `guard-dangerous-commands.sh` resolves the effective verb behind wrappers,
  environment runners, and flags, catching what a prefix rule structurally
  cannot see: `git -C <path> commit`, `dotenv -e .env -- prisma migrate deploy`,
  `sudo npm publish`, `cat .env`. Fails closed.
- `guard-protected-paths.sh` and `format-changed-file.sh` as reviewed scripts.

**Self-validation** — `yarn claude:validate`, in CI

- Frontmatter schema, skill/agent name agreement, built-in command collisions,
  the 1,536-character listing cap, cross-reference resolution.
- Agents are read-only, judged by **effective tool pool** rather than by a phrase
  in their prose.
- Required deny floor present; Bash/PowerShell parity; MCP server-segment
  portability; git verb table parity between hook and settings.
- Inert `Write()`/`Glob()`/`NotebookEdit()`/`MultiEdit()` path rules in any tier.
- Hook scripts exist, parse, are executable, and are referenced by
  `settings.json`.
- **Guard hook behaviour**, against a ~40-command decision table. A crashing
  hook exits non-zero, which Claude Code treats as non-blocking — so an unbroken
  guard is not the same as a correct one, and a broken guard fails open.
- **Adoption checks**, quiet until the clone is renamed: architectural idioms the
  skills assert must exist in `src/`, decorators and named constants the docs
  reference, and a filled-in `## Consumers` table.
