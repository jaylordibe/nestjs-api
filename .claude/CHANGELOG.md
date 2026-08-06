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
