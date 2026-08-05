# ADR-[ID]: [Decision title]

- **Status:** PROPOSED
- **Date:** YYYY-MM-DD
- **Owners:** [Names/roles]
- **Source:** [Ticket/request/incident]
- **Risk:** Low | Medium | High | Critical

## 1. Executive recommendation

[Desired outcome, recommended approach, and primary trade-off.]

## 2. Ticket versus repository reality

### Product outcome (WHAT)

- 

### Prescribed method (HOW)

- 

### Factual reconciliation

| Claim | Grade | Repository reality | Evidence |
|---|---|---|---|
| | Confirmed/Stale/Incorrect/Ambiguous/Not found | | `path:line` |

### Current authoritative flow

```text
route/job/event
→ access metadata
→ guard/ability
→ validation
→ service
→ scoped Prisma transaction
→ audit/job/provider
→ response DTO
```

## 3. Constraints and invariants

- Module/layer:
- Error contract:
- Authorization/tenant:
- Data/soft-delete:
- Consumer compatibility:
- Operational:
- Migration:
- Non-goals:

## 4. Options

### Option A — [Name]

- Approach:
- Benefits:
- Risks:
- Compatibility:
- Security:
- Migration/operations:

### Option B — [Name]

- Approach:
- Benefits:
- Risks:
- Compatibility:
- Security:
- Migration/operations:

## 5. Decision

[Recommendation, rationale, and rejected alternatives.]

## 6. API and contract impact

- Route/method:
- Access decorator:
- Permission:
- Request DTO:
- Response DTO:
- Error codes:
- HTTP status:
- Swagger decorators:
- Pagination/order:
- Event/webhook:
- Web/mobile/external handoff:
- Mixed-version behavior:

Attach `api-contract.md` when material.

## 7. Data design

- Prisma models:
- soft-delete/hard-delete:
- ownership/tenant scope:
- constraints/indexes:
- partial uniqueness/selectors:
- transactions/concurrency:
- `@map`/`@@map`:
- migration file:
- existing data/backfill:
- deployment ordering:
- rollback/roll-forward:

Attach `database-design.md` when material.

## 8. Security and privacy

- Assets:
- actors:
- trust boundaries:
- authentication:
- object/function authorization:
- PLATFORM/BUSINESS scope:
- enumeration/404/403:
- client-tampering controls:
- replay/race:
- throttling:
- secrets/log redaction:
- audit:
- residual risk:

Attach `threat-model.md` for High/Critical work.

## 9. File-by-file implementation plan

| File | Responsibility | Exact change | Risk/contract |
|---|---|---|---|
| | | | |

Explicitly cover `Errors.*`, DTOs, authorization scoping, audit actor, Prisma,
Swagger, queues/providers, and config when relevant.

## 10. Test plan

| Requirement/risk | Test file/layer | Scenario | Expected evidence |
|---|---|---|---|
| | | | |

Include affected e2e specs, stable error codes, negative authorization/tenant
cases, serialization, soft deletion, concurrency, and retry behavior as
relevant.

## 11. Verification

- affected unit:
- affected e2e:
- `yarn build`:
- `yarn lint`:
- runtime exercise:
- security checks:
- permission/catalog check:
- migration SQL/test-DB evidence:
- logs/audit/metrics:

No local migration application.

## 12. Rollout and recovery

- deployment order:
- web/mobile dependency:
- feature flag/staging:
- migration/backfill:
- success signals:
- abort thresholds:
- rollback/roll-forward:
- repair/reconciliation:

## 13. Deliberate non-goals

- 

## 14. Open decisions and blockers

| Type | Question/blocker | Why it matters | Owner/evidence needed |
|---|---|---|---|
| | | | |

## 15. Approval

- **Decision:** Pending | Approved | Rejected | Superseded
- **Approved by:**
- **Date:**
- **Conditions/accepted risks:**
