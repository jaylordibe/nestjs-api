# Adopting and upgrading the Claude Engineering Framework

For someone who has just cloned this starter repository, or who wants to pull
later improvements into a project that already did.

**The Claude Engineering Framework** is the Claude Code tooling: `.claude/`,
`CLAUDE.md`, and `scripts/validate-claude-config.ts`. It is a
distinct, versioned thing from the **starter repository** that ships it — the
starter is the whole NestJS API, and you adopt that once by cloning. The
framework you keep adopting, every time you upgrade.

The framework version is in `.claude/VERSION`; what each version contains is in
`.claude/CHANGELOG.md`.

## Why this file exists

`.claude/` is copied, not installed. There is no package manager to tell you
that your copy is eighteen months old, and no lockfile to diff. Left alone, four
projects each drift in their own direction and the "shared" framework becomes
four unrelated ones — which is the thing `CLAUDE.md` forbids in application code
and would be embarrassing to permit in the tooling that enforces it.

Two mechanics keep that from happening: a version you can read, and an adoption
gate that fails until the copy actually describes *your* project.

## Adopting

`yarn claude:validate` stays quiet about adoption while `package.json` still
carries the starter repository's own name. **Renaming the package is what turns
the adoption checks on**, so do it first and let the validator drive the rest.

1. **Rename the project.** `package.json` `name`, and `SERVICE_NAME` in `.env`
   and `.env.example` — `SERVICE_NAME` drives the database name, container
   names, and the JWT `iss`/`aud`.
2. **Run `yarn claude:validate`.** It will now fail. Every failure is a decision
   the framework cannot make for you; work through them.
3. **Fill in the `## Consumers` table** in `CLAUDE.md`. Every client that
   programs against this API, or `_(none — internal only)_` and why. The design,
   implement, and review gates all ask which consumers a contract change forces
   a matching change in; an unfilled table answers "none" for the wrong reason.
4. **Reconcile the architecture.** The validator checks that the idioms,
   decorators, and constants the skills cite actually exist in `src/`. If you
   removed CASL, or the queue, or the audit log, those checks fail — and they
   are right to. **Rewrite the affected skills to describe your repository.**
   Do not delete the check to make it pass: a framework whose skills confidently
   describe an architecture you do not have is worse than no framework, because
   every review it runs is measured against the wrong contract.
5. **Point the issue-tracker rules at your server.** `.mcp.json` names the MCP
   server; the deny rules in `.claude/settings.json` use a glob server segment
   so they keep working, but the *tool names* are Atlassian's. Run `/mcp`, list
   your tracker's tools, and confirm the write verbs are covered.
6. **Update `CLAUDE.md`** — *Project*, *Architecture*, and *Cross-cutting
   conventions* describe the starter repository. They are the authoritative
   contract source the gates read, so they have to describe you.
7. **Re-run `yarn claude:validate` until green**, then commit.

Steps 3–6 are not busywork: they are the framework refusing to review your code
against someone else's contracts.

## Upgrading

`.claude/` has no installer, so an upgrade is a reviewed diff — but a scoped one.

1. Read `.claude/CHANGELOG.md` from your version forward. **MAJOR** entries name
   what you must edit by hand; **MINOR** and **PATCH** name files you can copy.
2. Diff the upstream tree against yours:

   ```bash
   diff -ru /path/to/nestjs-api/.claude .claude
   ```

3. Take the framework files wholesale: `hooks/`, `standards/`, `templates/`,
   the `gate-*` and `work-item` skills, and `scripts/validate-claude-config.ts`.
   These are deliberately project-neutral so they can be replaced without
   merging.
4. **Merge, never replace,** the files that carry your project: `CLAUDE.md`,
   `.claude/settings.json` (your allow list and MCP server), `.mcp.json`, the
   domain skills you rewrote in adoption step 4.
5. Copy the new `.claude/VERSION`.
6. Run `yarn claude:validate`, `yarn lint`, and `yarn build`.

## Back-porting an improvement

A fix found while working in a downstream project is worth more than the same
fix invented here, because it came from something that actually broke.

Back-port it when it is **project-neutral** — a guard-hook gap, a validator
check, a stage contract, a wording fix in a standard. Do not back-port anything
naming your domain, your consumers, or your architecture.

The change lands here as ordinary work: it goes through the gates like anything
else, gets a `CHANGELOG.md` entry under the next version, and bumps
`.claude/VERSION`. A guardrail that arrives without a changelog entry is
invisible to every other project, which defeats the point of having a baseline.
