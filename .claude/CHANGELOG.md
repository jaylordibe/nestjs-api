# Claude Engineering Framework — changelog

The **Claude Engineering Framework** is this repository's Claude Code tooling:
`.claude/`, `CLAUDE.md`, and `scripts/validate-claude-config.ts`. It is versioned and copied into projects, separately from the starter repository
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

## 2.1.0 — 2026-08-06

Closes two gaps 2.0.0 opened. Removing committed ADRs solved the churn but took
the approval trace and the commit-to-rationale link with it; neither needed a
document to come back.

- **The Stage 6 report is now emitted as a paste-ready PR description.** The
  pull request becomes the durable rationale — versioned by the host, linked to
  the commit, visible to consumer developers, and read at review time rather
  than filed away. Zero files in the tree.
- **Stage 2 writes the approved scope, risk tier and every condition into the
  Stage 3 task.** Tasks survive compaction; the conversation does not. Without
  it a resumed session could not tell *approved* from *presented*, and a summary
  claiming the user approved something is not evidence. `gate-implement`'s hard
  gate now reads that record, and stops when neither it nor a human-invoked
  `/gate-approve` is present.

Files: `.claude/skills/work-item/SKILL.md`,
`.claude/skills/gate-implement/SKILL.md`.

## 2.0.0 — 2026-08-06

**MAJOR — the design artifact changed. Adopters must change their process.**

Committed ADRs are gone. The `docs/adr/` directory and the old ADR template are
deleted, `templates/plan.md` takes their place, and the design is now a **plan**
presented through Claude Code's native plan flow. Approval is the plan-mode
decision; there is no `Status:` line, no §15, no §16, and nothing written to the
repository.

### Why

Cost, not principle. A committed ADR had to be kept in sync at every stage of a
run: implementation divergences rewrote the file plan, review findings rewrote
the options and the rationale, validation appended an evidence table. One real
`/work-item` run edited its ADR about **fifteen times**, including a full rewrite
of a 400-line document — more effort than the six-file change it described. The
ADR had become a running log of the pipeline rather than a record of a decision.

Two sections structurally guaranteed post-approval edits:

- **§16 Validation record** could not be written until validation had run.
- **§9 File-by-file plan** predicted the diff and went stale the moment
  implementation reality differed. The diff *is* the file-by-file.

### What adopters must do

1. Delete your `docs/adr/` directory and the old ADR template; copy
   `templates/plan.md`.
2. Copy the six workflow skills, `standards/gate-handoff.md`,
   `standards/architecture.md`, `.claude/README.md`, `.claude/ADOPTING.md`, and
   `scripts/validate-claude-config.ts` (its ADR validation is removed).
3. In your `CLAUDE.md`, replace the *ADR location* section with *Where the design
   lives*, and change "ADR" to "plan" in the gate list and risk table.

Prior ADRs remain in Git history. Nothing is lost that a `git log` cannot reach.

### What this costs, stated plainly

The plan is local, its filename is generated rather than descriptive, CI can
enforce nothing about it, and a commit no longer links to the reasoning behind
it. **When a decision must outlive the session, put it in a code comment beside
the thing it protects** — that is now the durable mechanism, and it is a better
one for the case that actually matters: someone about to delete a line they do
not understand.

Resume-by-path is also gone. That was a deliberate trade: resuming happened on
roughly one run in ten, and did not justify a document every other run had to
maintain.

## 1.2.0 — 2026-08-06

**Adopters of 1.0.0 and 1.1.0: your build is very likely broken. Read this
first.**

Adopting the framework adds `scripts/validate-claude-config.ts`. For most NestJS
projects that is the first and only `.ts` file outside `src/`, and TypeScript
infers `rootDir` as the common ancestor of every file in the build program — so
it silently rebases the emit root to the repository root. `dist/main.js` becomes
`dist/src/main.js`, and a Dockerfile that runs `CMD ["node", "dist/main.js"]`
cannot resolve its entrypoint.

`yarn build` still exits 0. Nothing fails until a container will not start. This
is how it was found: a staging deploy in an adopting project crash-looped with
`MODULE_NOT_FOUND`, and the same defect was then confirmed latent in this
baseline.

**Check your project in one command:**

```bash
yarn build && ls dist/main.js
```

If that says "No such file" and `dist/src/main.js` exists instead, you have it.

### The fix

Copy `scripts/verify-build-artifacts.ts`, `scripts/verify-build-artifacts.spec.ts`
and `scripts/build-config-contract.spec.ts`, then apply by hand — these are
project-owned files an upgrade cannot overwrite for you:

- **`tsconfig.build.json`** — add `"include": ["src/**/*"]`, and in
  `compilerOptions` add `"rootDir": "./src"` and
  `"tsBuildInfoFile": "./dist/tsconfig.build.tsbuildinfo"`. Add your tooling
  directory to `exclude`.
- **`package.json`** — add
  `"postbuild": "ts-node --transpile-only scripts/verify-build-artifacts.ts"`,
  and set jest `rootDir: "."` with `roots: ["<rootDir>/src", "<rootDir>/scripts"]`
  (otherwise a spec under `scripts/` is collected by nothing and reports as
  passing). Adjust `collectCoverageFrom` and `coverageDirectory` accordingly.
- **`.dockerignore`** / **`.gitignore`** — add `**/*.tsbuildinfo` and
  `*.tsbuildinfo`.
- **`.github/workflows/test.yml`** — the `docker` job now runs the image it
  builds, rather than only CVE-scanning it.

`tsBuildInfoFile` is **not optional**. Pinning `rootDir` moves the incremental
cache out of `dist/`, where `deleteOutDir` can no longer clear it; a stale cache
then makes tsc emit nothing while exiting 0, so `yarn build` twice in a row
yields assets with no code.

Do **not** add your tooling directory to `.dockerignore`: `postbuild` runs inside
the Docker build stage, so the check script must be in the build context.

Rationale, alternatives, and the two self-inflicted defects found while fixing it
were recorded in an ADR that 2.0.0 removed; see Git history if you need it.

### Why the framework carries a project-build fix

The framework's own file is the trigger. Shipping the validator without this
warning means every adopter inherits a silent, deploy-breaking defect — so the
warning belongs with the thing that causes it, even though the fix lives in
project-owned files.

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
