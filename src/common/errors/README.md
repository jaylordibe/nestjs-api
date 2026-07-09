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
| `path` | Request URL. |
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
| `SESSION_INVALIDATED` | Token `iat` predates `passwordChangedAt` — password rotated, email changed, or `/auth/logout-all` was called. | ✅ |
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

### Infrastructure (HTTP 429, 500, 503)

| Code | Trigger |
|---|---|
| `RATE_LIMITED` | `@nestjs/throttler` rejected. |
| `EXTERNAL_SERVICE_UNAVAILABLE` | Third-party integration unavailable (SMS / email / storage providers, etc.). |
| `INTERNAL_ERROR` | Catch-all 500 for unexpected runtime errors. Real exception logged server-side; response never leaks internals. |

## Adding a new error scenario

1. Add a new code to `error-code.enum.ts` with JSDoc explaining the trigger. **Additive only — never repurpose an existing code.**
2. Add a factory in `errors.ts` returning the correct `HttpException` subclass with the typed payload.
3. Use it: `throw Errors.myNewCode();` at the call site.
4. Document it in the catalog above.
5. If clients need to special-case it, update the "Client logout rule" section.

## Internal — for contributors

- **Never construct `BadRequestException` / `NotFoundException` / `ConflictException` / `UnauthorizedException` / `ForbiddenException` / `ServiceUnavailableException` directly** outside `src/common/errors/`. ESLint enforces this (`no-restricted-syntax`). Use `Errors.*` so every throw flows through the standard envelope with a meaningful code.
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
