---
name: auth-security
description: This repository's answers for authentication and account security — the JWT and session contract, login and registration behavior, password reset links, OTP purpose binding, and throttling on public authentication routes.
when_to_use: Use when changing src/modules/auth, JWT strategy or session validation, registration/login/logout, password or account recovery, email or phone verification, OTP generation/consumption, login throttling, credential checks, authentication errors, or public authentication endpoints.
user-invocable: false
---

# Authentication security — this repository's answers

The `himoa:domain-auth` skill carries the questions and failure modes of any
authentication change. This file carries **only this repository's answers**.
Cross-cutting rules these flows also obey — the `Errors.*` factory, response
DTOs and `@Exclude()` + `@ApiHideProperty()`, `AuditService` and the request
envelope, config access, provider helpers, log redaction, datetime decorators,
the global throttle — are in `AGENTS.md`, with their mechanics in
`docs/engineering-conventions.md`. They are not repeated here.

Read first: `src/modules/auth/**`, `src/common/errors/README.md`, and the
existing auth e2e specs. Source is authoritative; do not invent a token, OTP,
session or verification design the implementation already defines.

Permissions, roles, scope, ownership and 403-versus-404 belong to the
`authorization` skill.

## JWT and session authority

- Claims are `sub`, `jti` and the registered `iat`/`exp`/`iss`/`aud` only — no
  roles, permissions, membership or ownership in the token. `iat` is pinned to
  the session's issue instant; the `passwordChangedAt` cutoff compares against it. Grants are re-read per request
  (`src/common/authorization/README.md`, Caching and invalidation).
- Preserve the `jti` session/revocation contract. Issuer and audience derive
  from `SERVICE_NAME`; the JWT strategy validates issuer, audience, signature,
  expiry and session state.
- Identity reads use `prisma.scoped`, so soft-deleted accounts cannot
  authenticate. Deletion and suspension are independent states — never one
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

## Login and registration

- Login failures (unknown identifier, wrong password, inactive account) are
  `INVALID_CREDENTIALS`. An unknown identifier still runs a dummy bcrypt
  compare, as Laravel and Django do. `EMAIL_NOT_VERIFIED` is returned only after
  the password matched.
- Registration answers like any validation error: an already-registered email
  is 409 `UNIQUE_CONSTRAINT_VIOLATION` (`details.field = 'email'`); a disposable
  domain (`isDisposableEmail()`, `common/util/disposable-email.util.ts`) is 400
  `EMAIL_DOMAIN_DISALLOWED`. Login does not check the domain.
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
  (plus `occurredAt` for the password-changed notice); the worker mints any
  token and renders the email.

## OTPs

- Purpose binding is `OtpPurpose` (`src/common/enums/`). A code or token issued
  for one purpose must never validate for another.
- Consumption that changes account state runs inside a transaction.
- A new sensitive body field extends `redact.paths` (see `AGENTS.md`, Logging).

## Throttling authentication routes

The global throttle is **not sufficient** for these. `POST /auth/login` is keyed
by lower-cased identifier + IP (`loginThrottleTracker`, 5/min); there is no
account lockout. Registration, login, refresh, verify-email, resend
verification, request/reset password, and phone OTP request/verify each carry
their own `@Throttle({ default: { limit, ttl } })`. So does every route that
checks `currentPassword` (`/users/me/password`, `/users/me/email`,
`/users/me/gdpr-erase`, 5/min — a stolen access token must not become a
password oracle) or hashes one for an admin (`POST /users`,
`PATCH /users/:id/password`, 20/min). E2e runs skip throttling, so a new
limit is pinned in a controller spec (`users-controller-throttle.spec.ts`).

Whose budget a request spends is `UserAwareThrottlerGuard`'s decision: a valid
access token spends its user's, everything else the client IP's. Every
`@Public()` route spends the IP's **even when a token is sent** — otherwise one
address holding N accounts would multiply each public limit above by N. The
authenticated limits above (`currentPassword` routes, phone OTP) are per user,
so N accounts on one address do get N budgets there. The IP is
`request.ip`, so it is only as honest as `TRUST_PROXY` (see "Client
topologies" in `docs/deployment/README.md`).

## Required tests when relevant

Use the `e2e-testing` skill for the harness.

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
