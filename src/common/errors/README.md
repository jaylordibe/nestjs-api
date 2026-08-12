# Error responses

This API emits a single, predictable envelope on every error response — regardless of source (HTTP guard, validation, Prisma, business logic, throttler, unhandled). Clients (web + mobile) program against the machine-readable `errorCode`, not against `message` (which may be re-worded or localized).

## The envelope

```json
{
  "statusCode": 401,
  "error": "Unauthorized",
  "errorCode": "TOKEN_EXPIRED",
  "message": "Your session has expired. Please log in again.",
  "details": null,
  "path": "/api/users/me",
  "timestamp": "2026-05-13T08:30:00.000Z",
  "requestId": "9c7d5e88-1ab2-4ef3-9c0d-7a3e1b2d4f56"
}
```

| Field | Purpose |
|---|---|
| `statusCode` | HTTP status code. |
| `error` | HTTP reason phrase only (`Unauthorized`, `Bad Request`, `Conflict`). Don't program against this; use `errorCode`. |
| `errorCode` | **Stable machine-readable identifier.** The contract. See catalog below. |
| `message` | Human-readable, may be re-worded or localized. For UI display. |
| `details` | Structured supplementary data; `null` when not applicable. Shape depends on `errorCode` — see catalog. |
| `path` | Request URL, **with secret-bearing query parameters replaced by `[redacted]`**. Clients feed error envelopes into their own error trackers, so an unredacted value would ship a credential to a third-party system every time an email-verification or password-reset link fails. The parameter names are in `common/util/redact-url-secrets.util.ts`; the path itself is untouched, so the field still answers what it exists to answer — which endpoint failed. |
| `timestamp` | ISO-8601 server time. |
| `requestId` | Echoes `X-Request-Id` (or generated UUID). Quote this in support tickets to correlate with logs. |

## Client logout rule

The single rule for web + mobile auth-state management:

```
on HTTP 401:
  switch (body.errorCode) {
    case 'TOKEN_MISSING':
    case 'TOKEN_INVALID':
    case 'TOKEN_EXPIRED':
    case 'TOKEN_REVOKED':
    case 'SESSION_INVALIDATED':
    case 'USER_INACTIVE':
      // Session is dead. Clear token, redirect to login.
      break;
    case 'EMAIL_NOT_VERIFIED':
      // Show "verify your email" CTA. Do NOT log out.
      break;
    case 'CURRENT_PASSWORD_INCORRECT':
    case 'INVALID_CREDENTIALS':
    default:
      // Surface body.message in the form. Do NOT log out.
  }
```

The `TOKEN_*` / `SESSION_INVALIDATED` / `USER_INACTIVE` cluster is the only set that should clear local credentials. Everything else is either a login-form error or a re-auth-protected operation — the user is still validly signed in.

## ErrorCode catalog

### Authentication (HTTP 401)

| Code | Trigger | Auto-logout? |
|---|---|---|
| `TOKEN_MISSING` | No `Authorization` header on a protected route. | ✅ |
| `TOKEN_INVALID` | Token malformed / bad signature / `iss` or `aud` mismatch / has a `purpose` claim. | ✅ |
| `TOKEN_EXPIRED` | Token `exp` claim is in the past. | ✅ |
| `TOKEN_REVOKED` | Token `jti` is in the Redis logout blocklist (the user explicitly logged this session out). | ✅ |
| `SESSION_INVALIDATED` | Token `iat` predates `passwordChangedAt`, the session cutoff. Every path that ends sessions moves it: password change or reset, email change, `/auth/logout-all`, support-initiated `POST /users/:id/revoke-sessions`, account deactivation, soft deletion, and GDPR erasure. | ✅ |
| `USER_INACTIVE` | User row missing / `isActive=false` / soft-deleted. Collapsed to one code to avoid enumeration leaks. | ✅ |
| `INVALID_CREDENTIALS` | `/auth/login` wrong email/password or account locked (timing-equalized). | ❌ |
| `EMAIL_NOT_VERIFIED` | Login blocked: `emailVerifiedAt` is null. | ❌ |
| `CURRENT_PASSWORD_INCORRECT` | Re-auth in `/me/password`, `/me/email`, `/me/gdpr-erase`, `/me/request-phone-verification`. Token still valid. | ❌ |

### Authorization (HTTP 403)

| Code | Trigger |
|---|---|
| `INSUFFICIENT_ROLE` | Generic 403 fallback for a bare framework `ForbiddenException`. Application code should emit `PERMISSION_DENIED` instead — it names the refused action and subject. |
| `ADMIN_SELF_TARGET_FORBIDDEN` | Admin trying an operation that's refused against themselves (e.g. `PATCH /users/:id/password` when `:id === self.id`). |

### Validation / bad input (HTTP 400)

| Code | Trigger | `details` shape |
|---|---|---|
| `VALIDATION_FAILED` | class-validator failure on a DTO (the default ValidationPipe folds the per-field messages into the envelope `message`). | `null` |
| `INVALID_OTP` | Bad or expired OTP (phone-verify, password-reset). | `null` |
| `INVALID_LINK` | Bad or expired JWT-link (verify-email). | `null` |
| `FK_REFERENCE_INVALID` | Prisma P2003 — foreign key references a record that doesn't exist. | `{ field: string }` |

### Resource state (HTTP 404, 409)

| Code | Trigger | `details` shape |
|---|---|---|
| `RESOURCE_NOT_FOUND` | Generic 404 (also Prisma P2025). | `{ resource: string }` |
| `UNIQUE_CONSTRAINT_VIOLATION` | Prisma P2002 — unique index violation. | `{ field: string }` |
| `RESOURCE_CONFLICT` | Generic 409 for application-level conflicts. | `null` |

### Business memberships and invitations (HTTP 400, 403, 409)

| Code | Status | Trigger | `details` shape |
|---|---|---|---|
| `LAST_OWNER_PROTECTED` | 409 | The operation would leave a live business with no owner who can act: removing, demoting, or suspending the last one — or **taking the account of somebody who solely owns a business out of service**, which means `DELETE /users/me`, `DELETE /users/:id`, and `PATCH /users/:id` with `{ "isActive": false }`. Deactivation counts because an inactive account cannot authenticate, so the business is just as unadministrable as if the owner had been deleted. Fires for **every** caller, platform admins included: it is a data-integrity invariant, not an authorization rule. | `{ businesses: { id, name }[] }` on the account paths, so the caller can act; `null` on the membership paths, where they already named the business. |
| `MEMBERSHIP_NOT_ACTIVE` | 409 | The membership exists but is not in a state that permits this operation. | `{ status: string }` |
| `ROLE_NOT_ASSIGNABLE` | 403 | The role is out of scope, above the caller's rank ceiling, or privileged while the caller holds no `assignRole BusinessMembership`. **One code for all three**, so a caller probing for escalation cannot learn which wall they hit; the remedy is the same either way. | `null` |
| `INVITATION_INVALID` | 400 | Unknown, consumed, revoked, rotated by a resend, addressed to a different account, or presented by a caller who has not verified control of the invited address. **Deliberately indistinguishable**, so a token cannot be probed. | `null` |
| `INVITATION_EXPIRED` | 400 | Distinguishable on purpose: the holder already proved possession of a real token, so this discloses nothing new, and their remedy differs — ask for a resend. | `null` |

`POST /users/me/gdpr-erase` never raises `LAST_OWNER_PROTECTED`. Erasure answers
a legal obligation and cannot be refused for a commercial relationship, so it
soft-deletes the solely-owned businesses instead. That asymmetry with
`DELETE /users/me` is deliberate.

### Infrastructure (HTTP 429, 500, 503)

| Code | Trigger |
|---|---|
| `RATE_LIMITED` | Too many requests. Emitted by the global `@nestjs/throttler` guard, and by application code via `Errors.rateLimited()`. A client cannot tell the two apart, and does not need to — the remedy is the same. Note only the throttler sets `Retry-After`; a factory-thrown 429 carries no such header, so a client must have its own backoff and not depend on one being present. |
| `EXTERNAL_SERVICE_UNAVAILABLE` | Third-party integration unavailable (SMS / email / storage providers, etc.). |
| `INTERNAL_ERROR` | Catch-all 500 for unexpected runtime errors. Real exception logged server-side; response never leaks internals. |

## Adding a new error scenario

1. Add a new code to `error-code.enum.ts` with JSDoc explaining the trigger. **Additive only — never repurpose an existing code.**
2. Add a factory in `errors.ts` returning the payload wrapped in the Nest exception class for that status — a semantic subclass (`ConflictException`, `NotFoundException`, …) wherever one exists. Nest ships no subclass for a few statuses this API can emit (429 among them); those construct `HttpException` directly, which is allowed **only inside `src/common/errors/`**. `Errors.rateLimited()` is the worked example.
3. Use it: `throw Errors.myNewCode();` at the call site.
4. Document it in the catalog above.
5. If clients need to special-case it, update the "Client logout rule" section.

## Internal — for contributors

- **Never construct `HttpException` — or `BadRequestException` / `NotFoundException` / `ConflictException` / `UnauthorizedException` / `ForbiddenException` / `ServiceUnavailableException` — directly** outside `src/common/errors/`. ESLint enforces this (`no-restricted-syntax`). Use `Errors.*` so every throw flows through the standard envelope with a meaningful code. `HttpException` is on that list for a specific reason: Nest has no subclass for several statuses this API can emit, so the raw base class — not a subclass — was always the way a throw would quietly escape the envelope. If no factory fits your case, add one rather than throwing a raw status.
- The default status→code fallback in `GlobalExceptionFilter` keeps framework throws safe (a bare 403, the throttler 429, the default ValidationPipe 400 all still get a programmable `errorCode`), but application code should always go through the factory.
- Tests should assert `body.errorCode`, not `body.message`. Messages are free to rotate; codes are the contract.


## Authorization codes (added with the RBAC + CASL layer)

| code | status | `details` | meaning |
|---|---|---|---|
| `PERMISSION_DENIED` | 403 | `{ action, subject? }` | Authenticated, but no CASL rule grants this action on this subject. Emitted by `PermissionsGuard` and by service-layer `assertCan`. |
| `BUSINESS_CONTEXT_MISSING` | 400 | — | A business-scoped permission was checked but the request never named a business (no `:businessId` route param, no `businessId` in the body). |
| `INSUFFICIENT_ROLE` | 403 | — | Legacy generic 403; still emitted when a bare `ForbiddenException` reaches the global filter. Prefer `PERMISSION_DENIED`, which names what was refused. |

**Neither new code triggers client auto-logout.** The token is perfectly valid;
the caller simply lacks authority. Only the `TOKEN_*` / `SESSION_INVALIDATED` /
`USER_INACTIVE` cluster clears credentials.

### Why a cross-tenant read is 404, not 403

Tenant isolation happens in the query (`accessibleBy`), so another business's
record is never loaded and surfaces as `RESOURCE_NOT_FOUND`. A 403 there would
confirm the record exists. A 403 is reserved for "you can see it, but you may
not do this to it". See `src/common/authorization/README.md`.
