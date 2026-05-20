---
name: nestjs-auth-security
description: Use when working on auth, login/register, JWT, email verification, OTP/password reset, phone verification, lockout/timing hardening, base-URL routing, the password-change notification, the audit-log request context, or doing a security review of an endpoint/DTO (enumeration, timing, replay, FK escalation, role abuse, log redaction).
---

# Auth & security model

Deliberate hardening — know these before relaxing any of them. The defaults below are the floor, not the ceiling.

## Security model

- **`JWT_SECRET`** Joi `.min(32).required().invalid(...)` — rejects the ex-template-default at boot. Regenerate: `openssl rand -hex 48`.
- **`JWT_EXPIRES_IN` = 30d** — consumer-app default. Security relies on `passwordChangedAt` invalidation, not short expiry. For banking/admin: drop to `1h` + add a refresh flow.
- **JWT `iss`/`aud`** bound to `SERVICE_NAME` on sign AND verify. Tokens can't be replayed across services.
- **Token invalidation on password change**: `User.passwordChangedAt` written on create + every password update. `JwtStrategy` rejects tokens with `iat` strictly earlier than `passwordChangedAt` (sub-second tolerance prevents false-reject on freshly-issued) → `SESSION_INVALIDATED`.
- **Per-token revocation (logout)**: JWT carries `jti`. `POST /auth/logout` writes `logout:jti:<jti>` to Redis with TTL = token remaining lifetime. `JwtStrategy` does `EXISTS` per request → `TOKEN_REVOKED`. **Fail-open on Redis outage** — warning logged, request allowed. For a forced session kill during an incident, use `logout-all` (Postgres-backed).
- **Session-wide revocation (logout-all)**: `POST /auth/logout-all` bumps `passwordChangedAt` → the existing `iat` check kills all outstanding tokens. Postgres-only, unaffected by Redis.
- **Admin self-target refused** on `PATCH /users/:id/password` — throws 403 `ADMIN_SELF_TARGET_FORBIDDEN` when `userId === actorId`. Admins must use `/me/password` (requires current password) — blocks hijack → takeover.
- **Lockout**: 5 failed logins → `lockedUntil = now + 15m`. Successful login clears. Locked accounts return the generic `INVALID_CREDENTIALS` (timing-equalized).
- **Login timing normalized**: unknown email still runs a bcrypt compare against a dummy hash — no enumeration via wall-clock.
- **bcrypt cost = 12**. `@MinLength(8)` + `@MaxLength(72)` (bcrypt truncation guard) + regex (letter + digit) on every new-password field (not `currentPassword`). 8-char min is the project-wide convention across every password DTO.
- **`@Public()`**: use sparingly. Any public endpoint with user input needs its own `@Throttle(...)`. Anonymous-traffic routes live in `src/modules/public/` under a class-level `@Throttle`.
- **Generic 500**: `GlobalExceptionFilter` returns `errorCode INTERNAL_ERROR` + `"Internal server error"` for non-`HttpException`; the real message is logged server-side, never leaked.
- **Response DTO `@Exclude()`**: password, passwordChangedAt, failedLoginCount, lockedUntil, otpHash, otpPurpose, otpExpiresAt, emailVerifiedAt on `UserResponseDto`. Never bypass the DTO.
- **Soft-deleted blocked from auth**: `AuthService.login` and `JwtStrategy.validate` go through `prisma.scoped` — soft-deleted users are indistinguishable from unknown (same 401 `INVALID_CREDENTIALS` / `USER_INACTIVE`, same timing via dummy bcrypt). No explicit `if (user.deletedAt)` check — dead code since the query never returns deleted.

New resources with user-facing secrets (API keys, tokens): never plaintext, `@Exclude()` from DTO, unique errors via the global filter.

## Error codes (auth)

All auth/user errors flow through the `Errors.*` factory and emit a stable `errorCode`. The login auto-logout cluster (`TOKEN_*`, `SESSION_INVALIDATED`, `USER_INACTIVE`) is the only set clients clear credentials on; `INVALID_CREDENTIALS`, `EMAIL_NOT_VERIFIED`, `CURRENT_PASSWORD_INCORRECT` keep the session/form alive. Full catalog + client logout rule: `src/common/errors/README.md`.

## Email verification flow (JWT link, stateless)

1. `POST /auth/register` creates the user with `emailVerifiedAt = null`, awaits `sendEmailVerificationLink`, returns `{ message }` — **no access token**. Provider outage surfaces as 5xx at register time.
2. Link format: `{API_BASE_URL}/auth/verify-email?token=<jwt>`. JWT carries `{ sub: userId, purpose: 'email_verify' }`, 24h expiry.
3. Consumption: `jwtService.verify`, check `purpose === 'email_verify'`, set `emailVerifiedAt = now`. Idempotent (re-verify = 200 no-op). Any failure → `Errors.invalidLink()` (opaque 400, all failure modes indistinguishable).
4. Login gate: `AuthService.login` throws 401 `EMAIL_NOT_VERIFIED` **after** a successful password match if unverified. Wrong-password stays generic `INVALID_CREDENTIALS` — the specific error only leaks to someone who already knows the password.
5. `POST /auth/resend-verification`: public, throttled, always 200. No enumeration.

**Cross-checks**: `JwtStrategy` rejects any token with a `purpose` claim (`TOKEN_INVALID`) — a stolen verification link can't be an access token; the verification JWT shares `JWT_SECRET` but is bound by `purpose`; `resendEmailVerification` is a silent no-op for soft-deleted/already-verified users.

## OTP lifecycle

Single `otpHash`/`otpPurpose`/`otpExpiresAt` triple per user, reused across purposes (one in-flight OTP at a time). Purposes live in `src/common/enums/otp-purpose.enum.ts` (`PASSWORD_RESET`, `PHONE_VERIFY`, …).

### Password reset

1. `requestPasswordReset`: 6-digit code → `bcrypt.hash` → `otpHash`. `otpPurpose = 'password_reset'`, `otpExpiresAt = now + 15m`. Raw code via email. **Always 200** (the controller returns a constant — no enumeration).
2. `resetPassword`: verify purpose + expiry, `bcrypt.compare`, apply (hash new password), null all three OTP fields, clear lockout counters.

Attacker guards: (a) `requestPasswordReset` always 200; (b) `resetPassword` opaque `Errors.invalidOtp()` for every failure mode (wrong email / expired / wrong code indistinguishable); (c) strict per-IP `@Throttle` on both endpoints; (d) `otpPurpose` check so a code minted for one flow can't be replayed in another.

### Phone verification

A two-step verified-phone change. Both endpoints throttled at 5/60s/IP (the SMS send budget AND the OTP brute-force surface).

1. `POST /users/me/request-phone-verification` → `requestPhoneVerification(userId, currentPassword, phoneNumber)`. **Re-auth gated**: verifies `currentPassword` first (`Errors.currentPasswordIncorrect()` on mismatch) so a stolen JWT alone can't redirect the phone number to attacker-controlled — same hijack-takeover defense as the email-change endpoint. Then mints an OTP whose hash binds the code to the target number (`bcrypt.hash('${otp}:${phoneNumber}')`) so a code delivered to phone X can't be replayed to claim phone Y. `otpPurpose = 'phone_verify'`. Dispatches via `SmsService.sendPhoneVerificationOtp`.
2. `PATCH /users/me/verify-phone` → `verifyAndUpdatePhoneNumber(userId, dto, actorId)`. Checks `otpPurpose === 'phone_verify'` + expiry + `bcrypt.compare('${otp}:${phoneNumber}')`; same opaque `Errors.invalidOtp()` on every failure (can't distinguish wrong-code / expired / wrong-number). On success: sets `phoneNumber`, stamps `phoneNumberVerifiedAt = now` (semantically "last verified at," re-running re-stamps), clears the OTP triple (single-use).

Plain `PATCH /users/me/phone` updates the number with **no** OTP and always clears `phoneNumberVerifiedAt` (the new number isn't proven owned). Use the OTP flow when a verified number is required.

`phoneNumberVerifiedAt` is **exposed** on `UserResponseDto` (mirrors `emailVerifiedAt`'s role on the email side, though `emailVerifiedAt` itself is `@Exclude()`d). New OTP flow: add a purpose to the `OtpPurpose` enum + dedicated endpoints — don't overload an existing purpose.

## Password-change notification email

Fires from every password-mutating path (`/me/password`, admin `/users/:id/password`, admin `PATCH /users/:id` with a password, password-reset OTP). **Not** on initial create or `gdprErase`. Best-effort (logs failure, doesn't block — a password change must succeed even if the email provider is down; the audit log still captures it).

## Base URLs (auth/email routing)

- `API_BASE_URL` — the API host; emails that link to a *backend handler* (the verify-email click) compose hrefs from it.
- `WEB_BASE_URL` — the customer-facing frontend; emails that link the customer to a *page* (confirmation, CTA) use it.

## Audit-log context

`AuditService.record({ action, actorId, targetUserId, metadata })` — best-effort (try/catch in the service; an audit failure never blocks the mutation). Wired into admin create/update/delete, admin password reset, self password reset, email-verified, logout/logout-all. Add a `record()` call from any new privileged code path. Sensitive request bodies (`password`, `newPassword`, `currentPassword`, `otp`) are redacted in pino logs — extend `redact.paths` in `app.module.ts` for new sensitive fields.

## Security-review checklist (any new endpoint/DTO)

- **Enumeration**: does a 200/404/timing difference reveal whether an email/resource exists? Collapse to one opaque response + dummy work for timing parity.
- **Re-auth on privileged self-mutation**: email/phone change, gdpr-erase, password change all require `currentPassword`. New "change my X" endpoints should too.
- **Throttle**: every `@Public()` or OTP/SMS/email-dispatching endpoint needs its own `@Throttle`.
- **Response DTO**: secrets `@Exclude()` + `@ApiHideProperty()`; never return raw rows.
- **Errors via `Errors.*`**: stable `errorCode`, opaque messages on auth failures.
- **FK escalation / role abuse**: can a USER set `userId`/`role`/`isActive` through the create/update DTO? Whitelist (`forbidNonWhitelisted`) + actor-scoping in the controller.
- **Log redaction**: new sensitive body fields added to `redact.paths`.
