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

  private getTargetField(
    err: Prisma.PrismaClientKnownRequestError,
  ): string | undefined {
    const target = err.meta?.target;
    if (Array.isArray(target)) return target[0] as string | undefined;
    if (typeof target === 'string') return target;
    return undefined;
  }

  private humanize(field: string): string {
    return field
      .replace(/([A-Z])/g, ' $1')
      .toLowerCase()
      .replace(/^./, (c) => c.toUpperCase());
  }
}
