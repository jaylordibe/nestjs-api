import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import {
  AppExceptionPayload,
  ErrorResponseBody,
} from '../errors/app-exception';
import { ErrorCode } from '../errors/error-code.enum';

// Single global filter. Catches every uncaught throwable and emits the
// standard error envelope (see src/common/errors/README.md). Priority
// order in `catch()`:
//
//   1. Prisma's PrismaClientKnownRequestError — translated by code
//      (P2002 → 409, P2003 → 400, P2025 → 404).
//   2. HttpException (and all its subclasses, including ThrottlerException
//      and Nest's built-in Unauthorized/Forbidden/etc.) — pulls a
//      structured AppExceptionPayload out of the response if present
//      (Errors.* factory), else falls back to a status-based default code.
//   3. Anything else — generic 500, real error logged but never leaked.
//
// This filter replaces the legacy `AllExceptionsFilter` and
// `PrismaExceptionFilter`. One file, one envelope, one mental model.

// Subset of the meta shape emitted by @prisma/adapter-pg for P2002
// errors. Prisma's public types don't describe this nested object, so
// we declare just the path we actually read.
interface AdapterPgMeta {
  target?: unknown;
  driverAdapterError?: {
    cause?: {
      constraint?: {
        fields?: unknown;
      };
    };
  };
}

interface Translated {
  status: number;
  errorCode: ErrorCode;
  message: string;
  details?: unknown;
}

const HTTP_REASON: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable Entity',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal Server Error',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
};

// Untagged HttpExceptions (e.g. Nest's RolesGuard ForbiddenException, the
// throttler, or the default ValidationPipe BadRequestException) fall back
// to a sensible code based on HTTP status, so clients still get a
// programmable contract for every error the framework itself raises.
const STATUS_TO_DEFAULT_CODE: Record<number, ErrorCode> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_FAILED,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.TOKEN_INVALID,
  [HttpStatus.FORBIDDEN]: ErrorCode.INSUFFICIENT_ROLE,
  [HttpStatus.NOT_FOUND]: ErrorCode.RESOURCE_NOT_FOUND,
  [HttpStatus.CONFLICT]: ErrorCode.RESOURCE_CONFLICT,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
  [HttpStatus.SERVICE_UNAVAILABLE]: ErrorCode.EXTERNAL_SERVICE_UNAVAILABLE,
};

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    const translated = this.translate(exception);

    const body: ErrorResponseBody = {
      statusCode: translated.status,
      error: HTTP_REASON[translated.status] ?? 'Error',
      errorCode: translated.errorCode,
      message: translated.message,
      details: translated.details ?? null,
      path: request.url,
      timestamp: new Date().toISOString(),
      requestId: this.extractRequestId(request),
    };

    this.log(translated.status, request, exception);
    response.status(translated.status).json(body);
  }

  // ── Dispatch ────────────────────────────────────────────────────────

  private translate(exception: unknown): Translated {
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromPrisma(exception);
    }
    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }
    return this.fromUnknown();
  }

  // ── HttpException → envelope ─────────────────────────────────────────

  private fromHttpException(exception: HttpException): Translated {
    const status = exception.getStatus();
    const res = exception.getResponse();

    // Tagged exception (constructed via Errors.* factory) — pull the
    // structured payload off and use it verbatim.
    if (typeof res === 'object' && res !== null) {
      const payload = res as Partial<AppExceptionPayload> & {
        message?: string | string[];
      };
      if (typeof payload.errorCode === 'string') {
        return {
          status,
          errorCode: payload.errorCode,
          message: this.normalizeMessage(payload.message) ?? exception.message,
          details: payload.details,
        };
      }
      // Untagged HttpException (framework throw — ValidationPipe, guards,
      // throttler) — fall back to the status-based default code, but keep
      // the caller's message.
      return {
        status,
        errorCode: STATUS_TO_DEFAULT_CODE[status] ?? ErrorCode.INTERNAL_ERROR,
        message: this.normalizeMessage(payload.message) ?? exception.message,
      };
    }

    // String form: `new NotFoundException('...')` — Nest serializes the
    // string into the message field for us.
    const message = typeof res === 'string' ? res : exception.message;
    return {
      status,
      errorCode: STATUS_TO_DEFAULT_CODE[status] ?? ErrorCode.INTERNAL_ERROR,
      message,
    };
  }

  // ── Prisma → envelope ────────────────────────────────────────────────

  private fromPrisma(
    exception: Prisma.PrismaClientKnownRequestError,
  ): Translated {
    switch (exception.code) {
      case 'P2002': {
        const field = this.getTargetField(exception);
        return {
          status: HttpStatus.CONFLICT,
          errorCode: ErrorCode.UNIQUE_CONSTRAINT_VIOLATION,
          message: field
            ? `${this.humanize(field)} already in use`
            : 'Duplicate value for unique field',
          details: field ? { field } : null,
        };
      }
      case 'P2003': {
        const field = this.getTargetField(exception);
        return {
          status: HttpStatus.BAD_REQUEST,
          errorCode: ErrorCode.FK_REFERENCE_INVALID,
          message: field
            ? `${this.humanize(field)} references a record that does not exist`
            : 'Foreign key references a record that does not exist',
          details: field ? { field } : null,
        };
      }
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          errorCode: ErrorCode.RESOURCE_NOT_FOUND,
          message: 'Resource not found',
        };
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          errorCode: ErrorCode.INTERNAL_ERROR,
          message: 'Internal server error',
        };
    }
  }

  // ── Unknown → envelope ───────────────────────────────────────────────

  private fromUnknown(): Translated {
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      errorCode: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error',
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  // The default ValidationPipe exceptionFactory emits `message` as a
  // string[]. Flatten to a single string for the envelope's message
  // field (the field-level detail belongs in `details`, but the default
  // pipe doesn't populate it — clients still get a readable summary here).
  private normalizeMessage(
    message: string | string[] | undefined,
  ): string | undefined {
    if (Array.isArray(message)) {
      return message.join(', ');
    }
    return message;
  }

  // pino-http populates req.id; fall back to the inbound header so
  // operators who supply X-Request-Id manually still get correlation.
  private extractRequestId(request: Request): string | undefined {
    const id = (request as Request & { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return id;
    const header = request.headers['x-request-id'];
    if (typeof header === 'string' && header.length > 0) return header;
    if (Array.isArray(header) && header[0]) return header[0];
    return undefined;
  }

  // P2002 meta shape varies by driver path:
  //   - Classic Rust engine: meta.target = string[] or string
  //       (e.g. ['email'] or 'users_email_key')
  //   - adapter-pg (Prisma 7+): meta.target is undefined; the field list
  //       lives at meta.driverAdapterError.cause.constraint.fields
  //       (e.g. { fields: ['email'] })
  //   - Fallback: Prisma's message string contains
  //       "Unique constraint failed on the fields: (`email`)"
  // Check all three in order so we return a sensible field name
  // regardless of which path the error came from. For composite
  // uniques, returns the last column — imprecise but not misleading.
  private getTargetField(
    err: Prisma.PrismaClientKnownRequestError,
  ): string | undefined {
    const meta = err.meta as AdapterPgMeta | undefined;
    if (!meta) return this.extractFieldFromMessage(err.message);

    if (Array.isArray(meta.target) && meta.target.length > 0) {
      const first: unknown = meta.target[0];
      if (typeof first === 'string' && first.length > 0) return first;
    }
    if (typeof meta.target === 'string' && meta.target.length > 0) {
      const withoutSuffix = meta.target.replace(/_(key|idx|unique)$/i, '');
      const last = withoutSuffix.split('_').pop();
      if (last && last.length > 0) return last;
    }

    const adapterFields = meta.driverAdapterError?.cause?.constraint?.fields;
    if (
      Array.isArray(adapterFields) &&
      adapterFields.length > 0 &&
      typeof adapterFields[0] === 'string'
    ) {
      return adapterFields[0];
    }

    return this.extractFieldFromMessage(err.message);
  }

  // Parse the field name out of Prisma's message string as a last
  // resort. Example: "Unique constraint failed on the fields: (`email`)"
  // Composite: "... on the fields: (`platform`,`version`)" → picks
  // `platform`.
  private extractFieldFromMessage(message: string): string | undefined {
    const match = /fields:\s*\(`?([^`,)]+)`?/.exec(message);
    return match ? match[1].trim() : undefined;
  }

  private humanize(field: string): string {
    return field
      .replace(/([A-Z])/g, ' $1')
      .toLowerCase()
      .replace(/^./, (c) => c.toUpperCase());
  }

  private log(status: number, request: Request, exception: unknown): void {
    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`${request.method} ${request.url} -> ${status}`);
    }
  }
}
