---
name: auth-security
description: Applies this repository's authentication and account-security contract for registration, login, JWT sessions, OTP and verification flows, lockout, password changes, disposable-email handling, throttling, audit, and anti-enumeration behavior.
when_to_use: Use when changing src/modules/auth, JWT strategy or session validation, registration/login/logout, password or account recovery, email or phone verification, OTP generation/consumption, lockout, credential checks, authentication errors, or public authentication endpoints.
user-invocable: false
---

# Authentication security

Read first:

- `CLAUDE.md`
- `src/modules/auth/**`
- `src/common/errors/README.md`
- relevant email/SMS/provider contracts
- existing auth e2e specs

Repository source is authoritative. Do not invent a token, OTP, session, or
verification design from general convention when the current implementation
already defines one.

## Boundary with authorization

This skill covers identity, credentials, session validity, recovery, and
verification.

Use the `authorization` skill for permissions, roles, PLATFORM/BUSINESS scope,
ownership, tenant isolation, and 403-versus-404 behavior.

Authentication proves who the actor is. It does not prove what records or
actions the actor may access.

## Non-negotiable invariants

### JWT and session authority

- Keep JWT claims minimal: `{ sub, jti }`.
- Never place role grants, permission lists, business membership, or ownership
  authority in the token.
- Re-read grants server-side through the established authorization path so
  revocation takes effect without waiting for token expiry.
- Preserve the existing `jti` session/revocation contract.
- Validate issuer, audience, signature, expiry, and session state through the
  configured JWT strategy.
- Use `prisma.scoped` for user-facing identity reads so soft-deleted accounts
  cannot authenticate.
- Treat deletion, suspension, and lockout as independent states; do not merge
  them into one boolean or one error-specific leak.

### Credential and enumeration behavior

- Collapse login failures to the established safe error, normally
  `INVALID_CREDENTIALS`.
- Do not reveal whether an account exists, is disposable, is soft-deleted, or
  failed a password check when the contract intentionally hides that fact.
- Preserve timing resistance. Missing/blocked accounts must still execute the
  repository's dummy bcrypt path before returning.
- Registration of disposable-email addresses remains byte-identical to a normal
  successful registration response while silently creating no user and writing
  the required audit event.
- Non-auth contexts may use the explicit
  `Errors.emailDomainDisallowed(domain)` contract when disclosure is allowed.
- Never return raw provider, database, bcrypt, JWT, or mail/SMS errors.

### Passwords, OTPs, and verification artifacts

Before modifying any of these, trace the complete lifecycle:

```text
issue
→ persist/derive
→ deliver
→ attempt validation
→ consume/revoke
→ expire
→ audit
```

Preserve or strengthen:

- one-time use;
- purpose binding through `OtpPurpose` or the established equivalent;
- expiration;
- attempt/rate limits;
- replay resistance;
- transaction safety when consumption changes account state;
- safe handling of concurrent attempts;
- no plaintext credential/OTP/token logging;
- invalidation of superseded artifacts.

Do not silently make verification links, OTPs, password-reset artifacts, or
session identifiers reusable.

### Public endpoint abuse controls

Every public authentication or email/SMS-dispatch endpoint needs an explicit
route-level `@Throttle`.

Check:

- registration;
- login;
- resend verification;
- forgot/reset password;
- email/phone OTP issue and verify;
- account recovery;
- any endpoint that performs password hashing or sends a provider request.

Global throttling alone is not sufficient for expensive or dispatching routes.

### Errors and response contracts

- Throw through `Errors.*`.
- Preserve the stable error envelope and machine-readable `errorCode`.
- Clients must not depend on localized/free-form `message`.
- Use typed response DTOs or the shared `OperationAcknowledgementDto`.
- Hide sensitive fields in both runtime serialization and Swagger.
- Do not create distinguishable response bodies, statuses, or timings that
  defeat an anti-enumeration contract.

### Audit and logging

Audit security-sensitive actions and meaningful denied/blocked paths using the
established `AuditService` contract.

Preserve:

- actor/target identity when known;
- server-vouched request metadata;
- request ID/correlation;
- no caller-controlled `metadata.request`;
- pino redaction for passwords, OTPs, tokens, authorization, cookies, and new
  secret fields.

Audit writes remain best-effort only where the current contract explicitly says
they must not block the primary operation.

### Configuration and providers

- Read configuration through typed `configuration.ts` keys and
  `configService.getOrThrow`.
- Never read `process.env` directly outside the configuration factory.
- Use typed `EmailService` and `SmsService` helpers rather than raw generic
  provider calls.
- External calls need explicit timeout and safe failure handling.
- Retry only known transient provider failures; do not accidentally deliver
  multiple OTPs or reset links without a deliberate idempotency policy.

## Change workflow

1. Trace the current success and failure paths end to end.
2. Identify the public contract and anti-enumeration behavior.
3. Identify account/session/OTP state transitions and transaction boundaries.
4. Identify abuse, replay, concurrency, timing, and provider-failure risks.
5. Preserve authorization separation.
6. Implement through existing factories, DTOs, providers, audit, and config.
7. Add negative and regression tests before declaring the change complete.

## Required tests when relevant

- valid and invalid credentials;
- missing account and wrong password return the same public contract;
- timing-safe dummy-password path remains reachable;
- disposable-email registration is byte-identical and creates no user;
- unverified, suspended, locked, and soft-deleted account behavior;
- OTP purpose, expiry, one-time use, replay, concurrent attempts, and retry;
- password-reset invalidation and session revocation;
- public-route throttling;
- provider timeout/failure without secret leakage;
- stable `errorCode` and response DTO serialization;
- audit event and redaction behavior;
- tenant/permission behavior through the separate authorization tests.

Use the `e2e-testing` skill for the harness and evidence rules.
