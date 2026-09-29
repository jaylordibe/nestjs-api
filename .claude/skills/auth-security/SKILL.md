---
name: auth-security
description: This repository's answers for authentication and account security — the JWT and session contract, login and registration behavior, password reset links, OTP purpose binding, throttling on public routes, and the audit and provider contracts these flows must use.
when_to_use: Use when changing src/modules/auth, JWT strategy or session validation, registration/login/logout, password or account recovery, email or phone verification, OTP generation/consumption, login throttling, credential checks, authentication errors, or public authentication endpoints.
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
- Deletion and suspension are independent states. Do not merge them into one
  boolean.
- Ending sessions = move the cutoff (`passwordChangedAt`) and revoke refresh
  families, always together (`RefreshTokenService.endAllSessions*`). A
  self-service password or email change then starts a fresh session for the
  caller (`startSession`) and returns it, like Laravel's `logoutOtherDevices`.
  `waitForSessionCutoff` is correctness, not padding: the cutoff is rounded up
  to the next whole second, and a token minted inside that second would be
  dead on arrival.
- Email verification gates sign-in only. An existing session survives an email
  change while the new address awaits verification.
- `@nestjs/jwt`'s `expiresIn` is typed `number | StringValue`; the runtime string
  from `ConfigService` needs `as unknown as number` (see `auth.module.ts`).

## Login and registration

- Login failures (unknown identifier, wrong password, inactive account) are
  `INVALID_CREDENTIALS`. An unknown identifier still runs a dummy bcrypt
  compare, as Laravel and Django do. `EMAIL_NOT_VERIFIED` is returned only after
  the password matched.
- Registration answers like any validation error: an already-registered email
  is 409 `UNIQUE_CONSTRAINT_VIOLATION` (`details.field = 'email'`), a disposable
  domain (`isDisposableEmail()`) is 400 `EMAIL_DOMAIN_DISALLOWED`. Login does not
  check the domain.
- Forgot-password and resend-verification answer the same for every address.
- No timing padding beyond login's dummy compare.
- Never return raw provider, database, bcrypt, JWT, or mail/SMS errors.

## Password reset and verification links

- Password reset is a link: a 256-bit random token (`generateOpaqueToken`),
  SHA-256 hash in `otpHash` with `otpPurpose = password_reset` and a 60-minute
  `otpExpiresAt`, emailed as `PASSWORD_RESET_URL?token=…&email=…`. Redeeming it
  is single use, compares hashes in constant time, and ends every session. Any
  failure is `INVALID_LINK`.
- Verification links are 24h JWTs with a `purpose` claim; `JwtStrategy` refuses
  any token carrying `purpose`.
- Account emails are queued (`notifications` queue). The payload is the user id
  only; the worker mints the token and renders the email.

## OTPs and verification artifacts

- Purpose binding is `OtpPurpose` (`src/common/enums/`). A code or token issued
  for one purpose must never validate for another.
- Consumption that changes account state runs inside a transaction.
- No plaintext credential, OTP, or token reaches the logs — pino `redact.paths`
  in `app.module.ts` covers `authorization`, `cookie`, and password/OTP body
  fields. **Extend `redact.paths` when adding a new sensitive body field.**
- Timestamp inputs use `@IsUtcIsoString()`, never `@IsDateString()`.

## Public endpoint abuse controls

Global `ThrottlerGuard` is 100/60s/IP and is **not sufficient** for expensive or
dispatching routes. `POST /auth/login` is keyed by lower-cased identifier + IP
(`loginThrottleTracker`, 5/min). There is no account lockout.

Every `@Public()` authentication or email/SMS-dispatch route
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
- the dummy-password path remains reachable;
- duplicate and disposable sign-up return their error codes and create no user;
- unverified, suspended, and soft-deleted account behavior;
- OTP / reset-token purpose, expiry, one-time use, replay;
- password-reset invalidation and session revocation (other sessions only, for
  self-service changes);
- queued emails, asserted via `deliverQueuedEmails`;
- public-route throttling;
- provider timeout/failure without secret leakage;
- stable `errorCode` and response DTO serialization;
- audit event and redaction behavior.

Use the `e2e-testing` skill for the harness and evidence rules.
