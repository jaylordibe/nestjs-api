---
name: gate-validate
description: Performs read-only evidence validation for a reviewed change in this NestJS, Prisma, PostgreSQL, Redis, and BullMQ API using its actual Yarn build, lint, isolated e2e, database, security, runtime, and operational contracts; returns PASS, FAIL, or BLOCKED.
argument-hint: "[scope | risk focus]"
disable-model-invocation: true
disallowed-tools: Edit, Write, NotebookEdit
model: inherit
effort: high
---

# Validate the reviewed change

Input:

```text
$ARGUMENTS
```

Validation is read-only. Never modify source, tests, snapshots, lockfiles,
generated output, Prisma schema, migrations, configuration, or documentation to
manufacture a pass.

## 1. Establish scope

Read:

- `CLAUDE.md`;
- the approved plan;
- review report/outcome;
- current diff;
- `package.json` scripts;
- Jest/e2e configuration;
- `.env.test`;
- Docker Compose configuration;
- Prisma config and migration state;
- relevant source-owned READMEs.

State:

- exact worktree/commit;
- changed files and contracts;
- risk;
- required checks;
- unavailable prerequisites.

## 2. Preflight safety

Verify:

- no validation step targets the local dev DB;
- the test environment uses `.env.test`;
- the e2e harness owns test database drop/recreate;
- dev and test Postgres/Redis stacks remain isolated;
- no production credentials/endpoints/data are used;
- required containers/services are available;
- filtered test commands are supported by the repository scripts/config.

## 3. Canonical static gates

Run:

```text
yarn build
yarn lint
```

`yarn build` is the approved Prisma shape/compile check. Do not apply a migration
to validate schema shape.

Run affected unit specs when they exist.

Check for:

- focused/skipped tests introduced by the change;
- debug output/placeholders;
- unintended lockfile or generated changes;
- direct Nest exception construction;
- direct `process.env` access;
- handlers missing both `@Roles(...)` and `@Public()`;
- raw Prisma row returns;
- missing response/route decorators where detectable.

## 4. E2E gates

Run the affected e2e spec(s) using repository-supported Jest filtering.

The e2e run must use the separate test stack and worker isolation:

- cloned database per worker;
- separate Redis logical DB per worker;
- no reliance on globally exclusive external state.

Run full `yarn test:e2e` only when the module is complete or the user explicitly
requests it.

Label every filtered or partial run.

Ask `tester` whether the executed evidence covers the plan, review fixes, and
risk.

## 5. Database and migration gates

When schema/data changed, inspect and validate:

- schema and generated-client compatibility through build;
- one consolidated migration file;
- SQL correctness;
- snake_case mappings;
- partial unique indexes;
- constraints/indexes/FKs;
- soft-delete behavior;
- existing-data/backfill implications;
- deployment ordering and mixed-version safety;
- rollback or roll-forward plan.

Do not apply migrations to the local dev database.

The test e2e harness may exercise the migration only through its isolated test
database process.

Ask `database` to assess evidence.

## 6. Security and contract gates

Validate relevant:

- route authorization metadata;
- role decorators on every changed handler;
- negative tests for wrong role and another actor's record;
- 404/403 behavior;
- stable error envelope and `errorCode`;
- response DTO serialization and secret exclusion;
- public endpoint throttling;
- audit actor/event behavior;
- sensitive log redaction;
- dependency/security commands supported by this repository;
- Swagger and consumer contract behavior.

Ask `security` and `api` to assess whether the evidence covers the threat model
and contract.

## 7. Runtime/operational gates

When a runnable isolated surface exists, exercise actual success and failure
flows.

Verify:

- remote timeout behavior;
- retry/idempotency/duplicate handling;
- queue correlation IDs;
- terminal and poison-message behavior;
- health responses do not leak internal connection details;
- logs are useful and redacted;
- rollout and rollback prerequisites.

Ask `performance` for high-risk, asynchronous, integration, or load-sensitive
changes.

## 8. Verdict

Return exactly one:

- **PASS** — all required gates ran and passed; no release blocker remains.
- **FAIL** — at least one required gate ran and failed.
- **BLOCKED** — required evidence could not be obtained.

Never turn skipped, unavailable, partial, flaky, or unrelated failures into
PASS.

## 9. Evidence report

Use:

| Gate | Command/check | Exact scope | Result | Evidence/notes |
|---|---|---|---|---|

State:

- overall verdict;
- plan and acceptance-criteria coverage;
- failures and likely ownership;
- blockers and prerequisites;
- security evidence;
- migration and rollback readiness;
- consumer handoff status;
- residual risk;
- release recommendation.

## 10. Where the evidence goes

**Not into a document in the repository.** There is no validation-record section
to fill in. It could not be written until after validation had run, which made
it a guaranteed source of post-approval churn.

The evidence table from §9 belongs in the Stage 6 presentation and the pull
request — read once, by the person deciding whether to merge, which is the only
moment it changes anyone's behaviour.

Report the verdict exactly as produced. `FAIL` and `BLOCKED` are results, not
omissions to tidy away, and a run that only ever reports `PASS` records nothing.

Human approval, Git writes, migration application, deployment, and final risk
acceptance remain outside validation.

## 11. Handoff

Follow `.claude/standards/gate-handoff.md`, starting with its §0 mode table.

There is no next gate. Close with the verdict, the evidence table, and the
residual risk. In conductor mode, continue into `/work-item` Stage 6 — the
presentation the human actually acts on — rather than closing here.

On `PASS`, state plainly that the work exists only in the working tree and that
the commit, PR, migration application, and deployment are the user's — never
offer to perform them.

On `FAIL` or `BLOCKED`, name what failed or could not run, and point back to
`/gate-review` or the missing prerequisite.
