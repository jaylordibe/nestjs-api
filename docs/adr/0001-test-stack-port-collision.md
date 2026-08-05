# ADR-0001: Make a second clone of this template able to run its Docker stacks

- **Status:** ACCEPTED
- **Date:** 2026-08-06
- **Risk:** Low (developer environment and CI ergonomics; no runtime, contract, schema, or authorization surface)
- **Supersedes:** —

## 1. Executive recommendation

Keep the literal per-project port numbers, but add a **preflight port check** to
the e2e run that fails with an actionable message instead of an opaque
`AggregateError`, and document the port reassignment as a required step when
forking the template.

This is the smallest change that removes the actual cost of the problem. The
collision itself is a one-time, one-line fix per fork; the expensive part is
that today it surfaces as an unreadable failure deep inside Jest's `globalSetup`.

## 2. Ticket versus repository reality

### Product outcome (WHAT)

Two projects born from this template can be developed on one machine without
their Docker stacks fighting over host ports, and any collision that does happen
explains itself.

### Prescribed method (HOW)

None prescribed — discovered while running the e2e gate for the Claude tooling
work on 2026-08-06.

### Factual reconciliation

| Claim | Status | Evidence |
|---|---|---|
| `SERVICE_NAME` is the single source of truth for stack identity | **Partly true** | `docker-compose.yml:4,24` namespace *container names* by `${SERVICE_NAME}${COMPOSE_STACK_SUFFIX}`. Host ports are not derived from it. |
| Host ports are fixed literals | Confirmed | `docker-compose.yml:13,30` publish `${DB_PORT}:5432` / `${REDIS_PORT}:6379`; `.env.test:28,34` set `5434`/`6380`; `.env` sets `5433`/`6378`. |
| A sibling clone collides | Confirmed | InfoAlanya (a fork of this template) held `5434`/`6380` for two days; `docker compose --env-file .env.test up -d --wait` failed with `Bind for 0.0.0.0:5434 failed: port is already allocated`. |
| The failure is legible | **False** | See below. |
| Port clashes are undocumented | **Incorrect** *(added on resume, 2026-08-06)* | `README.md:56` already warns about "host ports 5433 / 6378 to avoid clashing with **local installs**", and `README.md:104` already troubleshoots "Port already in use (5433 / 6378)". The guidance exists — it is scoped to a locally-installed Postgres and to the **dev** ports only. |
| The test stack is covered by that guidance | **False** *(added on resume)* | Neither README location mentions `5434`/`6380`, another clone of this template, or the created-without-published-ports state. The e2e path — the only one that actually broke — is the uncovered one. |

### Current authoritative flow

`yarn test:e2e` → `pretest:e2e` runs `docker compose --env-file .env.test up -d
--wait` → Jest `globalSetup` (`test/setup/global-setup.ts`) connects on
`DB_PORT`/`REDIS_PORT` and drops/recreates the template database.

**The compounding failure mode is the real defect.** When the bind fails,
Compose leaves the containers in `Created` state. A later `up` *starts* those
existing containers — and they start **without host port publishing**. The
stack then reports `healthy`, `pg_isready` inside the container succeeds, and
only the host cannot reach it. Jest surfaces this as:

```text
Jest: Got error running globalSetup - test/setup/global-setup.ts, reason: [AggregateError]
```

No port, no host, no cause. Recovery is `docker compose --env-file .env.test up
-d --force-recreate --wait`, which is not discoverable from the error.

## 3. Constraints and invariants

- `.env.test` is the single source of truth for test configuration and is loaded
  unchanged by both developers and CI (`.github/workflows/test.yml` deliberately
  declares no `env:` block). Any solution must not introduce a second source.
- `.env.test` is committed **per project**, so different projects holding
  different port numbers is not a divergence — it is the intended granularity.
- CI runners are single-tenant; the collision cannot occur there. This is
  strictly a local-development problem, which bounds how much machinery it
  deserves.
- `docker compose down` is denied by `.claude/settings.json`; remediation
  guidance must not depend on it.

## 4. Options

### Option A — Document only

Add the reassignment step to the fork checklist; change no code.

- **For:** zero risk, zero maintenance.
- **Against:** leaves the opaque `AggregateError` in place, which is the part
  that actually costs time. Rejected on that basis alone.
- **Strengthened on resume:** documentation alone has effectively already been
  tried. `README.md` warns about port clashes in *two* places and still did not
  prevent this, because a reader only meets that text at clone time and the
  failure arrives weeks later wearing an unrelated face — a Jest `globalSetup`
  stack trace. Extending those sections is necessary and is folded into Option C;
  it is not sufficient on its own.

### Option B — Derive ports from a `PORT_OFFSET`

Introduce `PORT_OFFSET` in `.env`/`.env.test` and compute
`DB_PORT=$((5432 + PORT_OFFSET))` etc.

- **For:** one knob per fork; ports become systematically namespaced.
- **Against:** Compose does not do arithmetic in `${...}` interpolation, so the
  computation has to move into a shell wrapper or be duplicated back into the
  env file as literals — which is where we already are. It also makes
  `DATABASE_URL` (a literal string in `.env.test`) inconsistent with the derived
  port unless that too becomes computed. Cost exceeds the benefit.

### Option C — Preflight check + documented fork step (recommended)

Keep literal ports. Add a preflight script to `pretest:e2e` that, before
Compose runs, checks whether `DB_PORT`/`REDIS_PORT` are held by a container that
is **not** this project's, and fails with the specific remediation. Additionally
detect the created-without-published-ports state and name `--force-recreate`.

- **For:** fixes the expensive symptom; no new configuration surface; keeps
  `.env.test` authoritative; inert in CI where the ports are always free.
- **Against:** one more script to maintain (~40 lines, no dependencies).

## 5. Decision

**Option C.** The collision is cheap to fix once per fork; the illegible failure
is what recurs. Spend the change budget on the diagnostic, not on a
configuration abstraction that Compose cannot cleanly express.

## 6. API and contract impact

None. No request/response DTO, `errorCode`, enum, event payload, database shape,
or externally observable behavior changes. No consumer handoff.

## 7. Data design

None. No schema, migration, index, or constraint change.

## 8. Security and privacy

No trust boundary is crossed. The preflight reads local Docker state only and
must not print credentials — it reports port numbers and container names, never
`DB_PASSWORD` or `DATABASE_URL`. Note that `.env.test` values are committed
test-only constants by design.

## 9. File-by-file implementation plan

| File | Change |
|---|---|
| `scripts/preflight-test-stack.ts` | **New.** Resolve `DB_PORT`/`REDIS_PORT` from `.env.test`; if a port is held by a container whose name does not start with this project's `SERVICE_NAME`, fail naming the holder and the fix. If this project's containers exist but publish no host port, fail naming `--force-recreate`. Exit 0 when the ports are free or already correctly ours. |
| `package.json` | `pretest:e2e` becomes `ts-node --transpile-only scripts/preflight-test-stack.ts && docker compose --env-file .env.test up -d --wait`. |
| `README.md` §First-time setup (~line 56) | **Extend, do not add.** The step already reads "host ports 5433 / 6378 to avoid clashing with local installs"; widen it to *"…with local installs **and with other clones of this template**"*, and state that a fork must reassign `DB_PORT`/`REDIS_PORT` in **both** `.env` and `.env.test`, including the ports embedded in `DATABASE_URL`/`REDIS_URL`. |
| `README.md` §Troubleshooting (~line 104) | **Extend, do not add.** The entry covers only the dev ports; add `5434`/`6380`, name a sibling clone as the likely holder, and give `docker compose --env-file .env.test up -d --force-recreate --wait` as the fix for a stack that reports healthy but publishes no host port. |

## 10. Test plan

- Unit spec for the classifier: port free → pass; port held by a foreign
  container → fail with that container's name; our container present but
  unpublished → fail naming `--force-recreate`.
- Docker state is injected as a parsed structure, so the spec needs no daemon.
- No e2e change: the preflight is a `pretest` step, exercised by every run.

## 11. Verification

- `yarn build`, `yarn lint`, `yarn claude:validate`
- affected unit spec
- `yarn test:e2e` with ports free (passes) and with a deliberately bound port
  (fails with the intended message)

No migration is involved; nothing is applied to any database.

## 12. Rollout and recovery

Developer-tooling only; no deployment ordering, no mixed-version concern.
Rollback is reverting the `pretest:e2e` script back to the bare `docker compose`
invocation. CI is unaffected — the ports are always free on a fresh runner, so
the preflight is a no-op there.

## 13. Deliberate non-goals

- Not changing the port numbers themselves in this repository.
- Not introducing `PORT_OFFSET` or any computed-port scheme (Option B).
- Not touching InfoAlanya or any other fork.
- Not making the preflight stop, remove, or recreate anything on its own — it
  reports and exits non-zero. Container lifecycle stays with the human, per
  `CLAUDE.md`'s human-owned operations.

## 14. Open decisions and blockers

**None. Both rows were resolved on resume (2026-08-06); nothing blocks a decision.**

| Type | Question/blocker | Resolution |
|---|---|---|
| Product | Is per-machine multi-clone actually a supported workflow, or is one-clone-at-a-time acceptable? | **Resolved — supported.** Confirmed by the owner. Not hypothetical: InfoAlanya, a fork of this template, ran alongside this repository on the same machine for two days and is what produced the collision. Option C stands; the ADR is not a rejection candidate. |
| Scope | Should the fork checklist live in `README.md` or a dedicated `docs/scaffolding.md`? | **Resolved — extend `README.md`.** Both relevant sections already exist and already discuss port clashes (`:56`, `:104`); they are incomplete, not absent. A third location for port guidance is where the single-source-of-truth rule breaks down. `docs/scaffolding.md` rejected. |

## 15. Approval

- **Decision:** Approved
- **Approved by:** jaylordibe
- **Date:** 2026-08-06
- **Conditions/accepted risks:** none

## 16. Validation record

Filed after `/gate-validate`.

- **Verdict:**
- **Commit/worktree:**
- **Date:**

| Gate | Command/check | Exact scope | Result | Evidence/notes |
|---|---|---|---|---|
| | | | | |
