# Release readiness: [Change]

- **ADR:**
- **Risk:**
- **Release owner:**
- **Verdict:** PASS | FAIL | BLOCKED

## Approval and scope

- [ ] ADR is ACCEPTED.
- [ ] Implementation matches ADR or accepted amendment.
- [ ] No unresolved Critical/High review finding.
- [ ] Product/security/operations residual risks have named human owners.
- [ ] Cross-repository web/mobile/provider blockers are resolved.

## Project contracts

- [ ] `Errors.*` and stable `errorCode` preserved.
- [ ] Response DTOs prevent secret leakage.
- [ ] DTO validation follows repository rules.
- [ ] Every route has exactly one access decorator.
- [ ] Permission catalog and query-level tenant scoping are correct.
- [ ] Audit actor and security events are correct.
- [ ] Public/dispatch endpoints have throttling.
- [ ] Swagger contracts are explicit.
- [ ] No raw Prisma rows or direct Nest exceptions.
- [ ] Soft-delete nested reads and partial uniqueness are correct.
- [ ] Queue/provider timeout, retry, idempotency, duplicate, and failure behavior
      are defined.

## Evidence

- [ ] Affected unit specs passed.
- [ ] Affected e2e specs passed in isolated test workers.
- [ ] `yarn build` passed.
- [ ] `yarn lint` passed.
- [ ] Runtime success and failure flows were exercised where applicable.
- [ ] Security/authorization negative tests passed.
- [ ] Error envelope and serialization tests passed.
- [ ] No focused/skipped tests, debug code, or placeholders remain.

## Database

- [ ] Complete schema batch is in one appropriate migration.
- [ ] Migration was not applied to local dev DB by Claude.
- [ ] Existing-data/backfill plan is bounded and resumable.
- [ ] Index/constraint and lock impact is understood.
- [ ] Mixed-version deployment order is safe.
- [ ] Rollback or roll-forward is documented.
- [ ] Test DB evidence exists.

## Operations

- [ ] Logs are useful and redacted.
- [ ] Correlation IDs propagate to workers.
- [ ] Metrics/traces/alerts cover the changed path.
- [ ] Success signals and abort thresholds are defined.
- [ ] Feature-flag/staged rollout is ready where needed.
- [ ] Support/operations handoff is ready.
- [ ] Recovery/reconciliation owner is assigned.

## Human release decision

- Decision:
- Decided by:
- Evidence:
- Accepted risks:
- Blockers:
- Deployment order:
- Rollback authority:
