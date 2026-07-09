// Stable, machine-readable error identifiers emitted on every API error
// response. The values here are part of the public API contract — once
// shipped, NEVER rename or repurpose a code. Adding new codes is fine;
// removing or changing meaning is not.
//
// Clients (web + mobile) program against `errorCode`, not against
// `message` (which may be re-worded or localized). See
// `src/common/errors/README.md` for the consumer contract.

export enum ErrorCode {
  // ── Authentication (401) ─────────────────────────────────────────────
  /** No Authorization header on a protected route. */
  TOKEN_MISSING = 'TOKEN_MISSING',
  /** Token malformed, signature mismatch, `iss`/`aud` mismatch, or carries
   *  a `purpose` claim (verification links can't be used as access tokens). */
  TOKEN_INVALID = 'TOKEN_INVALID',
  /** Token `exp` claim is in the past. */
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  /** Token `jti` is in the Redis logout blocklist (per-token revocation). */
  TOKEN_REVOKED = 'TOKEN_REVOKED',
  /** Token `iat` predates user.passwordChangedAt — pw rotated, logout-all,
   *  or email change. All extant tokens for the user are invalidated. */
  SESSION_INVALIDATED = 'SESSION_INVALIDATED',
  /** User row missing, `isActive=false`, or soft-deleted. Collapsed to one
   *  code to avoid enumeration leaks (the strategy can't distinguish them
   *  via `prisma.scoped` anyway). */
  USER_INACTIVE = 'USER_INACTIVE',
  /** /auth/login: wrong email or password. Also covers lockout — generic by
   *  design (timing-equalized with bcrypt dummy compare). */
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  /** Login blocked: emailVerifiedAt is null. Leaked only after password
   *  verification (see auth.service.login). */
  EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED',
  /** Re-authentication in a `/me/*` flow failed (wrong currentPassword).
   *  CRITICAL: token is still valid — clients MUST NOT auto-logout on this. */
  CURRENT_PASSWORD_INCORRECT = 'CURRENT_PASSWORD_INCORRECT',

  // ── Authorization (403) ──────────────────────────────────────────────
  /** Generic 403 fallback. Emitted when a bare `ForbiddenException` reaches
   *  the global filter. Predates the CASL layer; prefer PERMISSION_DENIED,
   *  which carries the action/subject that was refused. Retained because
   *  error codes are a public, additive-only contract. */
  INSUFFICIENT_ROLE = 'INSUFFICIENT_ROLE',
  /** Admin attempting an operation against their own user row that the
   *  policy refuses (e.g. PATCH /users/:id/password where :id === self). */
  ADMIN_SELF_TARGET_FORBIDDEN = 'ADMIN_SELF_TARGET_FORBIDDEN',
  /** PermissionsGuard or a service-layer `assertCan` refused: the caller is
   *  authenticated but no CASL rule grants this action on this subject.
   *  `details` is `{ action: string; subject?: string }`.
   *
   *  NOTE: a *cross-tenant* read never reaches this code. Tenant isolation
   *  happens in the query (`accessibleBy`), so another business's record is
   *  simply not found → 404 RESOURCE_NOT_FOUND. A 403 here would confirm the
   *  record exists. */
  PERMISSION_DENIED = 'PERMISSION_DENIED',

  // ── Validation / bad input (400) ─────────────────────────────────────
  /** class-validator failure on a DTO. `details` is
   *  `Array<{ field: string; constraints: string[] }>`. */
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  /** Bad or expired OTP code (phone-verify, password-reset). */
  INVALID_OTP = 'INVALID_OTP',
  /** Bad or expired JWT-based link (verify-email). */
  INVALID_LINK = 'INVALID_LINK',
  /** Email is on a disposable / temporary provider. `details` is
   *  `{ domain: string }`. Used by direct rejections; auth register/login
   *  deliberately stay silent (no enumeration) — see AuthService. */
  EMAIL_DOMAIN_DISALLOWED = 'EMAIL_DOMAIN_DISALLOWED',
  /** Prisma P2003 — foreign-key references a record that doesn't exist.
   *  `details` is `{ field: string }`. */
  FK_REFERENCE_INVALID = 'FK_REFERENCE_INVALID',
  /** A business-scoped permission was checked but no business could be
   *  resolved from the request (no `:businessId` route param, no
   *  `businessId` in the body). Indicates a client calling a tenant-scoped
   *  route without naming the tenant. */
  BUSINESS_CONTEXT_MISSING = 'BUSINESS_CONTEXT_MISSING',

  // ── Resource state (404, 409) ────────────────────────────────────────
  /** Generic 404. `details` is `{ resource: string }`. */
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  /** Prisma P2002 — unique-index violation. `details` is `{ field: string }`. */
  UNIQUE_CONSTRAINT_VIOLATION = 'UNIQUE_CONSTRAINT_VIOLATION',
  /** Generic 409 for application-level conflicts that aren't a DB unique
   *  violation (e.g. business-rule clashes). */
  RESOURCE_CONFLICT = 'RESOURCE_CONFLICT',

  // ── Infrastructure (429, 500, 503) ───────────────────────────────────
  /** @nestjs/throttler rejected — too many requests. */
  RATE_LIMITED = 'RATE_LIMITED',
  /** Third-party integration is unavailable or returned an error
   *  (SMS / email / storage providers, etc.). */
  EXTERNAL_SERVICE_UNAVAILABLE = 'EXTERNAL_SERVICE_UNAVAILABLE',
  /** Catch-all 500 for unexpected runtime errors. The real exception is
   *  logged server-side; the response never leaks internals. */
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}
