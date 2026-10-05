import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ErrorCode } from './error-code.enum';

// Single point of construction for every domain-meaningful exception.
// Call sites use `throw Errors.tokenExpired()` instead of constructing
// `UnauthorizedException` (or any other built-in) directly; ESLint
// enforces this everywhere outside this directory.
//
// Why a factory rather than a custom `AppException extends HttpException`:
// preserving Nest's semantic exception classes (`UnauthorizedException`,
// `ForbiddenException`, etc.) keeps `@Catch(UnauthorizedException)`
// filters and Nest's own RBAC throws compatible. Each factory builds the
// right built-in plus a structured `AppExceptionPayload` that the global
// filter reads via `exception.getResponse()`.

export const Errors = {
  // ── 401 ────────────────────────────────────────────────────────────
  tokenMissing: (): UnauthorizedException =>
    new UnauthorizedException({
      errorCode: ErrorCode.TOKEN_MISSING,
      message: 'Authentication required',
    }),
  tokenInvalid: (): UnauthorizedException =>
    new UnauthorizedException({
      errorCode: ErrorCode.TOKEN_INVALID,
      message: 'Authentication token is invalid',
    }),
  tokenExpired: (): UnauthorizedException =>
    new UnauthorizedException({
      errorCode: ErrorCode.TOKEN_EXPIRED,
      message: 'Your session has expired. Please log in again.',
    }),
  tokenRevoked: (): UnauthorizedException =>
    new UnauthorizedException({
      errorCode: ErrorCode.TOKEN_REVOKED,
      message: 'This session has been logged out',
    }),
  sessionInvalidated: (): UnauthorizedException =>
    new UnauthorizedException({
      errorCode: ErrorCode.SESSION_INVALIDATED,
      message: 'Session invalidated. Please log in again.',
    }),
  userInactive: (): UnauthorizedException =>
    new UnauthorizedException({
      errorCode: ErrorCode.USER_INACTIVE,
      message: 'Account is unavailable',
    }),
  invalidCredentials: (): UnauthorizedException =>
    new UnauthorizedException({
      errorCode: ErrorCode.INVALID_CREDENTIALS,
      message: 'Invalid credentials',
    }),
  emailNotVerified: (): UnauthorizedException =>
    new UnauthorizedException({
      errorCode: ErrorCode.EMAIL_NOT_VERIFIED,
      message:
        'Please verify your email before logging in. Check your inbox or request a new verification link.',
    }),
  currentPasswordIncorrect: (): UnauthorizedException =>
    new UnauthorizedException({
      errorCode: ErrorCode.CURRENT_PASSWORD_INCORRECT,
      message: 'Current password is incorrect',
    }),
  // One error for unknown / expired / already-exchanged / revoked. The message
  // is deliberately incurious: any wording that hinted at WHICH case applied
  // would let a caller probe whether a token it holds is real.
  refreshTokenInvalid: (): UnauthorizedException =>
    new UnauthorizedException({
      errorCode: ErrorCode.REFRESH_TOKEN_INVALID,
      message: 'Your session has expired. Please sign in again.',
    }),

  // ── 403 ────────────────────────────────────────────────────────────
  insufficientRole: (): ForbiddenException =>
    new ForbiddenException({
      errorCode: ErrorCode.INSUFFICIENT_ROLE,
      message: 'You do not have permission to perform this action',
    }),
  adminSelfTargetForbidden: (message: string): ForbiddenException =>
    new ForbiddenException({
      errorCode: ErrorCode.ADMIN_SELF_TARGET_FORBIDDEN,
      message,
    }),
  // The CASL authorization refusal. The message is deliberately identical for
  // every action/subject pair — `details` carries the specifics for debugging
  // and for clients that want to explain the refusal, but the prose never
  // reveals whether the *resource* exists.
  permissionDenied: (action: string, subject?: string): ForbiddenException =>
    new ForbiddenException({
      errorCode: ErrorCode.PERMISSION_DENIED,
      message: 'You do not have permission to perform this action',
      details: subject ? { action, subject } : { action },
    }),

  // ── Workspace membership + invitations ──────────────────────────────
  // A workspace without an active owner is unadministrable: nobody can grow the
  // roster, and nobody can delete it. This fires for every caller, platform
  // admins included — `manage all` bypasses AUTHORIZATION, not data integrity.
  // `soleOwnedWorkspaces` is supplied by the ACCOUNT-deletion path, where the
  // caller has no way to guess which of their workspaces is blocking them — and
  // where the remedy differs (transfer or close the workspace, rather than
  // appoint a co-owner). Naming them is not a leak: they are workspaces the
  // caller owns.
  lastOwnerProtected: (
    soleOwnedWorkspaces?: readonly { id: string; name: string }[],
  ): ConflictException =>
    new ConflictException({
      errorCode: ErrorCode.LAST_OWNER_PROTECTED,
      message: soleOwnedWorkspaces?.length
        ? 'You are the only active owner of a workspace. Transfer ownership or delete the workspace before deleting this account.'
        : 'A workspace must always have at least one active owner. Appoint another owner first.',
      ...(soleOwnedWorkspaces?.length
        ? { details: { workspaces: soleOwnedWorkspaces } }
        : {}),
    }),
  membershipNotActive: (status: string): ConflictException =>
    new ConflictException({
      errorCode: ErrorCode.MEMBERSHIP_NOT_ACTIVE,
      message: 'That membership is not in a state that allows this operation',
      details: { status },
    }),
  // ONE code for both "wrong scope" and "outranks you". Splitting them would
  // let a caller probing for privilege escalation learn which wall they hit,
  // and the remedy is the same either way: pick a different role.
  roleNotAssignable: (): ForbiddenException =>
    new ForbiddenException({
      errorCode: ErrorCode.ROLE_NOT_ASSIGNABLE,
      message: 'You may not assign that role here',
    }),
  // Unknown, consumed, or revoked — deliberately indistinguishable, so a token
  // cannot be probed for existence. Same reasoning as refreshTokenInvalid().
  invitationInvalid: (): BadRequestException =>
    new BadRequestException({
      errorCode: ErrorCode.INVITATION_INVALID,
      message: 'This invitation is no longer valid',
    }),
  // Safe to distinguish: the holder already proved possession of a real token,
  // so this discloses nothing they did not have, and their remedy is different.
  invitationExpired: (): BadRequestException =>
    new BadRequestException({
      errorCode: ErrorCode.INVITATION_EXPIRED,
      message: 'This invitation has expired. Ask for a new one.',
    }),

  // ── 400 ────────────────────────────────────────────────────────────
  validationFailed: (
    details: Array<{ field: string; constraints: string[] }>,
  ): BadRequestException =>
    new BadRequestException({
      errorCode: ErrorCode.VALIDATION_FAILED,
      message: 'Validation failed',
      details,
    }),
  invalidOtp: (): BadRequestException =>
    new BadRequestException({
      errorCode: ErrorCode.INVALID_OTP,
      message: 'Invalid or expired verification code',
    }),
  invalidLink: (): BadRequestException =>
    new BadRequestException({
      errorCode: ErrorCode.INVALID_LINK,
      message: 'This link is invalid or has expired',
    }),
  // Sign-up with a disposable / temporary email provider.
  emailDomainDisallowed: (domain: string): BadRequestException =>
    new BadRequestException({
      errorCode: ErrorCode.EMAIL_DOMAIN_DISALLOWED,
      message: 'This email provider is not allowed',
      details: { domain },
    }),
  // Generic bad-request escape hatch for input that's malformed in a way
  // class-validator can't express (e.g. a JSON-string multipart field that
  // doesn't parse). Carries VALIDATION_FAILED — clients treat it like any
  // other 400 input error.
  badRequest: (message: string): BadRequestException =>
    new BadRequestException({
      errorCode: ErrorCode.VALIDATION_FAILED,
      message,
    }),
  // A workspace-scoped permission was checked, but the request never named a
  // workspace. 400 rather than 403: the caller may well be authorized, they
  // just didn't say where.
  workspaceContextMissing: (): BadRequestException =>
    new BadRequestException({
      errorCode: ErrorCode.WORKSPACE_CONTEXT_MISSING,
      message: 'A workspace context is required for this action',
    }),

  // ── 404 / 409 ──────────────────────────────────────────────────────
  // Pass `resource` alone for the canonical "X not found" message, or
  // supply a custom `message` for richer phrasing. The `details.resource`
  // field always carries the resource name so clients can program against it.
  resourceNotFound: (resource: string, message?: string): NotFoundException =>
    new NotFoundException({
      errorCode: ErrorCode.RESOURCE_NOT_FOUND,
      message: message ?? `${resource} not found`,
      details: { resource },
    }),
  uniqueConstraintViolation: (field: string): ConflictException =>
    new ConflictException({
      errorCode: ErrorCode.UNIQUE_CONSTRAINT_VIOLATION,
      message: `${field} already in use`,
      details: { field },
    }),
  resourceConflict: (message: string): ConflictException =>
    new ConflictException({
      errorCode: ErrorCode.RESOURCE_CONFLICT,
      message,
    }),

  // ── 429 ────────────────────────────────────────────────────────────
  // Nest ships no `TooManyRequestsException`, so this is the one place that
  // constructs a raw `HttpException` for 429 — which is exactly why the factory
  // needs to exist. Without it, every caller wanting a 429 reaches for
  // `new HttpException(...)` themselves and silently leaves the envelope behind.
  //
  // The global `ThrottlerGuard` does NOT come through here: it throws its own
  // `ThrottlerException`, which the filter maps to this same `RATE_LIMITED` code
  // by status. Sharing the code is deliberate — the remedy ("slow down and
  // retry") is identical, so splitting it would give clients a distinction they
  // cannot act on.
  //
  // One asymmetry worth knowing: the throttler sets `Retry-After` before
  // throwing, and this factory cannot — it returns an exception, and the global
  // filter has no way to attach a header on its behalf. A caller that can
  // compute a meaningful retry delay should set the header at the throw site.
  rateLimited: (
    message = 'Too many requests. Please retry later.',
  ): HttpException =>
    new HttpException(
      { errorCode: ErrorCode.RATE_LIMITED, message },
      HttpStatus.TOO_MANY_REQUESTS,
    ),

  // ── 413 / 415 ──────────────────────────────────────────────────────
  // Raised by the body parser, not by application code — see
  // `fromBodyParserError` below.
  payloadTooLarge: (message: string): PayloadTooLargeException =>
    new PayloadTooLargeException({
      errorCode: ErrorCode.PAYLOAD_TOO_LARGE,
      message,
    }),
  unsupportedMediaType: (message: string): UnsupportedMediaTypeException =>
    new UnsupportedMediaTypeException({
      errorCode: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
      message,
    }),

  // ── 503 ────────────────────────────────────────────────────────────
  externalServiceUnavailable: (message: string): ServiceUnavailableException =>
    new ServiceUnavailableException({
      errorCode: ErrorCode.EXTERNAL_SERVICE_UNAVAILABLE,
      message,
    }),
} as const;

// Express's body parser rejects some requests before any handler runs, with
// an `http-errors` object rather than an HttpException: oversized bodies
// (413), unsupported charsets and encodings (415). Nest's adapter maps only a
// malformed-JSON SyntaxError, so these reached the filter as unknown errors
// and answered 500 — a server fault for the client's own request.
//
// `expose === true` is http-errors' marker for a client error whose message
// is safe to return. Anything else stays unmapped and keeps the 500 path.
export function fromBodyParserError(error: unknown): HttpException | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { status, expose, message } = error as {
    status?: unknown;
    expose?: unknown;
    message?: unknown;
  };
  if (expose !== true || typeof message !== 'string') return undefined;

  switch (status) {
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return Errors.payloadTooLarge(message);
    case HttpStatus.UNSUPPORTED_MEDIA_TYPE:
      return Errors.unsupportedMediaType(message);
    case HttpStatus.BAD_REQUEST:
      return Errors.badRequest(message);
    default:
      return undefined;
  }
}
