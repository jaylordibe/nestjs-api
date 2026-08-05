# Application security standard — project edition

`CLAUDE.md`, the authorization README, and error README are authoritative.

## Authentication

- JWT contains identity/session identifiers, not authoritative role grants.
- Server-side grants are loaded per request and invalidated correctly.
- Auth/recovery paths resist account enumeration and timing differences.
- OTPs, passwords, tokens, cookies, and authorization headers are redacted.

## Authorization

Every protected operation verifies:

1. authenticated actor;
2. permission;
3. object visibility;
4. PLATFORM/BUSINESS scope;
5. ownership;
6. valid lifecycle state.

Route metadata proves policy exists; query scoping proves record access.

Use 404 for invisible records and 403 for visible forbidden actions.

## Input and authority

Never trust client-supplied:

- role or permission;
- tenant/business/provider/owner;
- price, amount, total, discount, or entitlement;
- approval/status transitions;
- audit request metadata.

Validate DTO shape, semantics, limits, and canonical representation.

## Sensitive sinks

Review inputs reaching:

- Prisma queries/writes;
- remote URLs;
- files/paths/parsers;
- shell or dynamic evaluation;
- email/SMS/provider calls;
- queue jobs;
- logs/audits;
- response DTOs/Swagger.

## Abuse controls

- public and OTP/email/SMS routes need explicit throttling;
- webhooks need signature/freshness/replay controls;
- retries/jobs need idempotency and duplicate safety;
- expensive operations need bounds/backpressure;
- admin/security actions need audit.

## Data exposure

- stable safe errors, no driver details;
- health responses never expose hosts/users;
- response DTOs exclude secrets;
- Swagger hides sensitive fields;
- pino redaction expands with new sensitive bodies;
- audit metadata is useful but minimized.

High-risk changes require a threat model and negative authorization/tenant tests.
Critical changes require qualified human security review.
