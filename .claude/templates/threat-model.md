# Threat model: [Change/system]

- **Related ADR/ticket:**
- **Risk:** High | Critical
- **Owner:**
- **Status:** Draft | Reviewed | Accepted

## Scope and security objectives

- In scope:
- Out of scope:
- Confidentiality:
- Integrity:
- Availability:
- Authorization:
- Tenant isolation:
- Privacy:
- Auditability:

## Assets and actors

| Asset | Sensitivity | Owner |
|---|---|---|
| | | |

| Actor | PLATFORM/BUSINESS scope | Ownership/privilege | Prohibited action |
|---|---|---|---|
| | | | |

## Entry points and trust boundaries

| Route/job/webhook | Access decorator/auth | Input | Sensitive sink |
|---|---|---|---|
| | | | |

## Abuse cases

| ID | Abuse case | Preconditions | Impact | Existing control |
|---|---|---|---|---|
| TM-01 | Cross-tenant record access | | | |
| TM-02 | Role/FK escalation | | | |
| TM-03 | Price/amount/entitlement tampering | | | |
| TM-04 | Enumeration/timing leak | | | |
| TM-05 | Replay/duplicate/race | | | |
| TM-06 | Sensitive log/error/Swagger leakage | | | |
| TM-07 | Public endpoint abuse | | | |

Add upload, SSRF, webhook, parser, queue, and provider cases where relevant.

## Required controls

| Threat | Control | Prevention/detection/recovery | Code owner | Test |
|---|---|---|---|---|
| | Query scoped via `AbilityScopedQueryService` | | | |
| | Stable safe `Errors.*` response | | | |
| | Route `@Throttle` | | | |
| | Server-side authoritative recomputation | | | |
| | Idempotency/duplicate protection | | | |
| | Pino redaction/audit event | | | |

## Security test plan

| Scenario | Expected status/errorCode | Data/audit expectation |
|---|---|---|
| unauthenticated | | |
| forbidden visible record | 403 | |
| invisible/cross-tenant record | 404 | |
| tampered FK/price/owner | | |
| duplicate/replay | | |
| rate limit | | |
| sensitive error path | | |

## Residual risk

| Risk | Reason retained | Compensating control | Human owner | Review date |
|---|---|---|---|---|
| | | | | |
