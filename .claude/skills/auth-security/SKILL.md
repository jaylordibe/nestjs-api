---
name: auth-security
description: This repository's answers for authentication and account security — the JWT and session contract, the anti-enumeration behavior of login and registration, OTP purpose binding, throttling on public routes, and the audit and provider contracts these flows must use.
when_to_use: Use when changing src/modules/auth, JWT strategy or session validation, registration/login/logout, password or account recovery, email or phone verification, OTP generation/consumption, lockout, credential checks, authentication errors, or public authentication endpoints.
user-invocable: false
---

# Authentication security — this repository's answers

The `engineering-framework:domain-auth` skill carries the questions and failure
modes that govern any authentication change. This file carries **only this
repository's answers**, and does not repeat the general reasoning.

Read first:

- `CLAUDE.md`
- `src/modules/auth/**`
- `src/common/errors/README.md`
- existing auth e2e specs

Repository source is authoritative. Do not invent a token, OTP, session, or
verification design from general convention when the current implementation
already defines one.

## Boundary with authorization

This skill covers identity, credentials, session validity, recovery, and
verification. Use the `authorization` skill for permissions, roles,
PLATFORM/BUSINESS scope, ownership, tenant isolation, and 403-versus-404.

## JWT and session authority

- JWT claims are exactly `{ sub, jti }`. No role grants, permission lists,
  business membership, or ownership authority in the token.
- Grants are re-read per request through `PermissionLoaderService` (Redis-cached,
  explicitly invalidated), so revocation bites immediately rather than at token
  expiry.
- Preserve the existing `jti` session/revocation contract.
- Issuer and audience derive from `SERVICE_NAME`; validate issuer, audience,
  signature, expiry, and session state through the configured JWT strategy.
- Use `prisma.scoped` for identity reads so soft-deleted accounts cannot
  authenticate.
- Deletion, suspension, and lockout are independent states. Do not merge them
  into one boolean or one error-specific leak.
- `@nestjs/jwt`'s `expiresIn` is typed `number | StringValue`; the runtime string
  from `ConfigService` needs `as unknown as number` (see `auth.module.ts`).

## Anti-enumeration contract

This repository hides account existence deliberately. The specific behaviors:

- Login failures collapse to `INVALID_CREDENTIALS`.
- A missing or blocked account still executes the **dummy bcrypt path** before
  returning, so timing does not distinguish it.
- Disposable-email registration (`isDisposableEmail()`,
  `common/util/disposable-email.util.ts`) is **byte-identical** to a successful
  registration — same 201, same body — while creating no user row and writing an
  audit event.
- Disposable-email login collapses to `INVALID_CREDENTIALS` behind the same
  timing-safe dummy bcrypt, and is audited.
- `Errors.emailDomainDisallowed(domain)` is for **non-auth** contexts only, where
  surfacing the reason is acceptable.
- Never return raw provider, database, bcrypt, JWT, or mail/SMS errors.

Any change that creates a distinguishable body, status, or timing on these paths
breaks the contract.

## OTPs and verification artifacts

- Purpose binding is `OtpPurpose` (`src/common/enums/`). An OTP issued for one
  purpose must never validate for another.
- Consumption that changes account state runs inside a transaction.
- No plaintext credential, OTP, or token reaches the logs — pino `redact.paths`
  in `app.module.ts` covers `authorization`, `cookie`, and password/OTP body
  fields. **Extend `redact.paths` when adding a new sensitive body field.**
- Timestamp inputs use `@IsUtcIsoString()`, never `@IsDateString()`.

## Public endpoint abuse controls

Global `ThrottlerGuard` is 100/60s/IP and is **not sufficient** for expensive or
dispatching routes. Every `@Public()` authentication or email/SMS-dispatch route
carries its own `@Throttle({ default: { limit, ttl } })`: registration, login,
resend verification, forgot/reset password, email/phone OTP issue and verify,
account recovery, and anything that hashes a password or calls a provider.

Throttler storage is Redis in dev/staging/prod and in-memory in test.

## Errors, responses, audit, config

- Throw through `Errors.*` — ESLint blocks direct `new *Exception` construction.
- Clients program against `errorCode`, never `message`.
- Side-effect endpoints return `OperationAcknowledgementDto { ok: boolean }`,
  never an inline object literal or inline `schema:`.
- Sensitive response fields need **both** `@Exclude()` and `@ApiHideProperty()`.
- Audit through `AuditService.record({ action, actorId, targetUserId, metadata })`.
  The server-vouched `metadata.request` envelope is merged automatically by the
  `ClsModule` middleware — never pass a caller `metadata.request` key. Audit
  writes are best-effort and never block the primary operation.
- Configuration reads go through `configService.getOrThrow<T>('dot.path')` into
  `configuration.ts`. Never `process.env` outside that file.
- Use the typed `emailService.sendTemplate(...)` /
  `smsService.sendPhoneVerificationOtp(...)` helpers, not raw `.send(...)`.
  Email templates compile at boot, so a `{{var}}` typo fails startup.

## Required tests when relevant

- valid and invalid credentials;
- missing account and wrong password return the same public contract;
- the timing-safe dummy-password path remains reachable;
- disposable-email registration is byte-identical and creates no user;
- unverified, suspended, locked, and soft-deleted account behavior;
- OTP purpose, expiry, one-time use, replay, concurrent attempts, retry;
- password-reset invalidation and session revocation;
- public-route throttling;
- provider timeout/failure without secret leakage;
- stable `errorCode` and response DTO serialization;
- audit event and redaction behavior.

Use the `e2e-testing` skill for the harness and evidence rules.
