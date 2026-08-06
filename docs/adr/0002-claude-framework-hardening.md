# ADR-0002: Harden the Claude Engineering Framework against silent failure and silent drift

- **Status:** ACCEPTED
- **Date:** 2026-08-06
- **Owners:** jaylordibe
- **Source:** Framework audit, comparing this template against a downstream project that adopted an earlier copy of it
- **Risk:** Medium

> **This ADR is retained as the worked reference example.** It is a real decision
> with real evidence, kept so an adopter can calibrate how much an ADR at each
> risk tier is supposed to contain. Note especially §6 and §7, which are marked
> not-applicable rather than deleted, and §16, whose `NOT RUN` rows carry a
> justification. An empty section and an absent one read very differently later.

## 1. Executive recommendation

Adopt three structural changes to `.claude/`: collapse the duplicated contract
lists to a single source, bind the existing risk table to the artifacts and the
review panel it was already meant to govern, and make the framework's own
failure modes detectable by `scripts/validate-claude-config.ts`.

The trade-off accepted: the gates get *less* prescriptive text, which reads as a
loss of rigour and is not. The rigour moves from four paraphrases into one
authoritative source plus checks that fail the build.

## 2. Ticket versus repository reality

### Product outcome (WHAT)

- A Claude Engineering Framework that can be copied into every new project as a
  baseline, stays correct as it is copied, and does not quietly stop protecting
  anything.

### Prescribed method (HOW)

- The audit's opening suggestion was to shorten the gate skills toward the
  ~75-line conductor used by the downstream project.

### Factual reconciliation

| Claim | Grade | Repository reality | Evidence |
|---|---|---|---|
| The gate skills are too long | Ambiguous | Length is not the defect; **duplication** is. 288 contract bullets across 7 files, with 12 concepts restated in 3–7 places each | measured across `CLAUDE.md`, the gate skills and `.claude/standards/` |
| The standards duplicate `CLAUDE.md` | Incorrect | Both standards files open by declaring `CLAUDE.md` authoritative and stay generic; the duplication is in the gate skills | `.claude/standards/coding.md:3`, `.claude/standards/security.md:3` |
| Shortening toward the downstream conductor is the fix | Incorrect | That conductor is better for one mature repo with one developer. It has no cross-session durability and no approval gate that the agent structurally cannot invoke — both of which this baseline needs | `.claude/skills/gate-approve/SKILL.md:20` |
| The risk table governs effort | Stale | The table existed and nothing read it. Every change got an ADR and the same review panel | `CLAUDE.md` — *Risk classification* |
| Agents are read-only | Confirmed, but unenforced | True of all eight, but the check searched their prose for the literal phrase `Never edit files`, so it never fired for three of them | `scripts/validate-claude-config.ts` |

### Current authoritative flow

```text
/work-item
→ context-mapper
→ gate-design (ADR)
→ gate-approve (human)
→ gate-implement
→ gate-review
→ gate-validate
→ present
→ issue comment
```

## 3. Constraints and invariants

- Module/layer: `.claude/` is developer tooling. The API must build, run, and test without it.
- Error contract: unaffected.
- Authorization/tenant: unaffected.
- Data/soft-delete: unaffected.
- Consumer compatibility: unaffected — no runtime surface changes.
- Operational: `yarn claude:validate` runs in CI beside lint and build, so any new check gates every pull request.
- Migration: none.
- Non-goals: see §13.

## 4. Options

### Option A — Shorten the gate skills toward the downstream conductor

- Approach: collapse the five gates into one prompt file, drop the agent panel and the ADR.
- Benefits: smallest context cost; matches a workflow already proven in one repo.
- Risks: loses cross-session resumability and the approval gate the agent cannot invoke. Those are the two things a *baseline* needs most, because an adopter will not rebuild them.
- Compatibility: would invalidate every existing ADR path argument.
- Security: removes the structural barrier against a design approving itself.
- Migration/operations: cheap now, expensive to reverse.

### Option B — De-duplicate, tier by risk, and make failures detectable

- Approach: gates name lenses and cite the authoritative source; the risk table decides artifact and panel size; the validator grows checks for the framework's own failure modes.
- Benefits: keeps durability and the approval barrier; removes the drift surface; every rule that was prose becomes a build failure.
- Risks: the validator becomes load-bearing, so a bug in it blocks work. Mitigated by fixture tests and by every check carrying an actionable message.
- Compatibility: no change to gate names, ADR paths, or the lifecycle.
- Security: strictly increases the floor.
- Migration/operations: adopters must fill in a consumers table and reconcile idioms — deliberate, see §12.

## 5. Decision

**Option B.**

The audit's prescribed method — shorten toward the downstream conductor — is
rejected. It optimises for the wrong subject: that conductor is well fitted to
one mature repository with one developer and no need to survive a lost session.
A baseline copied into many projects needs the opposite properties, and an
adopter who receives a stripped conductor will never add resumability or an
uninvocable approval gate back.

What the downstream conductor genuinely gets right is that it does not restate
its own project's contracts. That principle is adopted in full; its file count
is not.

## 6. API and contract impact

**Not applicable.** No route, DTO, error code, status, Swagger schema, or event
payload changes. `.claude/` contains no runtime code and is excluded from the
build. The `## Consumers` table added to `CLAUDE.md` is documentation about
consumers, not a change to any contract they hold.

## 7. Data design

**Not applicable.** No Prisma model, index, constraint, or migration. Nothing in
this change reads or writes a database.

## 8. Security and privacy

Medium risk, so this is a triage rather than a full threat model.

- Assets: the developer's repository, credentials in untracked env files, and the Git history.
- Actors: an agent running with tool access; a developer accepting a prompt.
- Trust boundaries: the permission layer and the `PreToolUse` hooks.
- Client-tampering controls: not applicable.
- Residual risk, stated plainly: **the command guard is defence in depth, not a sandbox.** A shell can express an operation its parser does not model — a verb built from a variable, an operation inside a script file, a here-doc. `permissions.deny` cannot fail open but only matches the exact command forms it names; the hook covers far more forms but is executable code that can fail. Neither is a boundary, and `.claude/README.md` says so in those words. A real boundary needs OS sandboxing or a container.
- Audit: not applicable.

## 9. File-by-file implementation plan

| File | Responsibility | Exact change | Risk/contract |
|---|---|---|---|
| `.claude/skills/work-item/SKILL.md` | Conductor | Load each gate on entering its stage; stop re-reading the always-on constitution; drop the Stage 3 contract list | Context cost |
| `.claude/skills/gate-implement/SKILL.md` | Implementation contract | 56 contract bullets replaced by a lens-to-source table | Single source of truth |
| `.claude/skills/gate-review/SKILL.md` | Review contract | 61 bullets replaced by a lens table; panel selection bound to risk tier | Review cost and depth |
| `.claude/skills/gate-design/SKILL.md` | Design contract | §7 and §8 cite the sources; §4 decides the artifact from the tier | Proportionality |
| `.claude/skills/gate-validate/SKILL.md` | Evidence gate | §10 skipped when there is no ADR | Removes a ritual step |
| `.claude/standards/gate-handoff.md` | Handoff sequence | Low-risk path skips the approval gate | Sequence correctness |
| `CLAUDE.md` | Constitution | Risk table made binding; `## Consumers` slot added | Authoritative source |
| `.claude/VERSION`, `.claude/CHANGELOG.md`, `.claude/ADOPTING.md` | Framework identity | New | Upgrade path |
| `scripts/validate-claude-config.ts` | Guardrail | Adoption checks, version/changelog agreement, widened drift detection | Load-bearing in CI |

## 10. Test plan

| Requirement/risk | Test file/layer | Scenario | Expected evidence |
|---|---|---|---|
| Every new check must catch an omission | `scripts/validate-claude-config.ts` | Break each check deliberately, one at a time | Each reports, with an actionable message |
| The guard hook must decide correctly | fixture table in the validator | ~40 commands across deny/ask/allow | All pass; a crash is reported as fail-open |
| The template must ship green | adoption gate | Validate unrenamed, then renamed | Quiet, then fails on the consumers table |
| Version and changelog must agree | version check | Bump one only | Reports the disagreement |

## 11. Verification

- affected unit: not applicable — no `src/` change.
- affected e2e: **NOT RUN**, justified — this change touches no file under `src/` or `test/`, and `.claude/` is excluded from the build. Running the suite would prove nothing about this diff.
- `yarn build`: PASS.
- `yarn lint`: PASS, with `scripts/` newly in scope.
- runtime exercise: the guard hook was executed directly against a decision table.
- security checks: the deny floor, the shell parity, and the guard decisions are all asserted by the validator.
- migration SQL/test-DB evidence: not applicable.

No local migration application.

## 12. Rollout and recovery

- deployment order: none; developer tooling only.
- web/mobile dependency: none.
- migration/backfill: none.
- success signals: `yarn claude:validate` green here; an adopting project sees the adoption checks fire on rename.
- abort thresholds: if a validator check produces false positives that developers start working around, remove that check rather than teaching people to ignore the build. A guardrail people route around is worse than none.
- rollback/roll-forward: revert the commit. Nothing is stateful.
- repair/reconciliation: projects that already copied an earlier tree upgrade via `.claude/ADOPTING.md`.

## 13. Deliberate non-goals

- Collapsing the five gates into one file.
- Removing the ADR for Medium-and-above work.
- Removing the specialist agents — the tiering right-sizes the panel instead.
- Making the command guard a sandbox. It is not one and is not documented as one.
- Backfilling ADRs for decisions already made.

## 14. Open decisions and blockers

| Type | Question/blocker | Why it matters | Owner/evidence needed |
|---|---|---|---|
| Evidence | Do seven review lenses earn their cost over the bundled engines? | The panel is currently justified by argument, not measurement | Owner: jaylordibe. Needs ~10 ADRs recording findings per lens in §16; drop lenses that never fire |
| Portability | The issue-tracker deny rules use a glob server segment, but the tool *names* are Atlassian's | A project on another tracker gets a floor that matches nothing | Owner: adopting project, per `.claude/ADOPTING.md` step 5 |

## 15. Approval

- **Decision:** Approved
- **Approved by:** jaylordibe
- **Date:** 2026-08-06
- **Conditions/accepted risks:** Accepted that the command guard is defence in depth and not a boundary (§8). Accepted that the review-panel size in §14 remains unproven until measured.

## 16. Validation record

- **Verdict:** PASS
- **Commit/worktree:** uncommitted working tree — the human owns the commit
- **Date:** 2026-08-06

| Gate | Command/check | Exact scope | Result | Evidence/notes |
|---|---|---|---|---|
| Static | `yarn build` | whole project | PASS | `nest build` clean |
| Static | `yarn lint` | `src`, `test`, `scripts` | PASS | `scripts/` newly in scope; one unsafe-assignment found and fixed |
| Framework | `yarn claude:validate` | `.claude/`, `CLAUDE.md`, `docs/adr/` | PASS | 11 skills, 8 agents, 39 markdown files |
| Framework | guard-hook fixtures | ~40 commands | PASS | run inside `yarn claude:validate` |
| Negative | deliberate breakage of each new check | 12 checks | PASS | each reported with an actionable message, then reverted |
| Negative | adoption gate | rename `package.json`, revalidate | PASS | quiet as template, fires once adopted |
| Unit | `yarn test` | — | NOT RUN | no `src/` change; see §11 |
| E2E | `yarn test:e2e` | — | NOT RUN | no `src/` or `test/` change; see §11 |

- **Coverage of acceptance criteria:** complete for §9. The §14 measurement question is deliberately open, not covered.
- **Residual risk:** the command guard is not a sandbox (§8). The validator is now load-bearing in CI.
- **Blockers and prerequisites:** none for this repository.
- **Migration/rollback readiness:** not applicable; no migration.
- **Consumer handoff status:** not applicable; no contract change.
