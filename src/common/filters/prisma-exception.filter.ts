import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';

interface ErrorResponseBody {
  statusCode: number;
  message: string;
  error: string;
  path: string;
  timestamp: string;
}

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

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(
    exception: Prisma.PrismaClientKnownRequestError,
    host: ArgumentsHost,
  ): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, message, error } = this.translate(exception);
    const body: ErrorResponseBody = {
      statusCode: status,
      message,
      error,
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    this.logger.warn(
      `${request.method} ${request.url} -> ${status} (Prisma ${exception.code})`,
    );

    response.status(status).json(body);
  }

  private translate(err: Prisma.PrismaClientKnownRequestError): {
    status: number;
    message: string;
    error: string;
  } {
    switch (err.code) {
      case 'P2002': {
        const field = this.getTargetField(err);
        return {
          status: HttpStatus.CONFLICT,
          message: field
            ? `${this.humanize(field)} already in use`
            : 'Duplicate value for unique field',
          error: 'Conflict',
        };
      }
      case 'P2003': {
        const field = this.getTargetField(err);
        return {
          status: HttpStatus.BAD_REQUEST,
          message: field
            ? `${this.humanize(field)} references a record that does not exist`
            : 'Foreign key references a record that does not exist',
          error: 'Bad Request',
        };
      }
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          message: 'Resource not found',
          error: 'Not Found',
        };
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Database error',
          error: 'Internal Server Error',
        };
    }
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

    // Classic target path
    if (Array.isArray(meta.target) && meta.target.length > 0) {
      const first: unknown = meta.target[0];
      if (typeof first === 'string' && first.length > 0) return first;
    }
    if (typeof meta.target === 'string' && meta.target.length > 0) {
      const withoutSuffix = meta.target.replace(/_(key|idx|unique)$/i, '');
      const last = withoutSuffix.split('_').pop();
      if (last && last.length > 0) return last;
    }

    // adapter-pg path
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
  // `platform`. Imprecise but never misleading.
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
}
