import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
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
      message: 'Invalid or expired verification link',
    }),
  // Direct rejection of a disposable / temporary email domain. NOTE: auth
  // register/login deliberately do NOT use this — they drop/collapse silently
  // to avoid leaking which domains are blocked (enumeration). Reserve this for
  // contexts where surfacing the reason is acceptable (e.g. an admin form).
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
  // A business-scoped permission was checked, but the request never named a
  // business. 400 rather than 403: the caller may well be authorized, they
  // just didn't say where.
  businessContextMissing: (): BadRequestException =>
    new BadRequestException({
      errorCode: ErrorCode.BUSINESS_CONTEXT_MISSING,
      message: 'A business context is required for this action',
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

  // ── 503 ────────────────────────────────────────────────────────────
  externalServiceUnavailable: (message: string): ServiceUnavailableException =>
    new ServiceUnavailableException({
      errorCode: ErrorCode.EXTERNAL_SERVICE_UNAVAILABLE,
      message,
    }),
} as const;
