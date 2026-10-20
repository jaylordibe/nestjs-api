import type { ArgumentsHost } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorCode } from '../errors/error-code.enum';
import { GlobalExceptionFilter } from './global-exception.filter';

// Answers one exception through the filter and returns what it sent.
function answer(exception: unknown): { status: number; body: unknown } {
  const sent: { status: number; body: unknown } = { status: 0, body: null };
  const response = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({
        originalUrl: '/api/users?search=juan',
        method: 'GET',
        headers: {},
      }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  new GlobalExceptionFilter().catch(exception, host);
  return sent;
}

// A Postgres error as `@prisma/adapter-pg` raises it: the SQLSTATE sits at
// `meta.driverAdapterError.cause.originalCode`.
function postgresError(sqlState: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('driver error', {
    code: 'P2010',
    clientVersion: Prisma.prismaVersion.client,
    meta: { driverAdapterError: { cause: { originalCode: sqlState } } },
  });
}

describe('GlobalExceptionFilter', () => {
  it('answers a statement cut off by its timeout (57014) with a retryable 503', () => {
    const { status, body } = answer(postgresError('57014'));
    expect(status).toBe(503);
    expect(body).toMatchObject({
      errorCode: ErrorCode.EXTERNAL_SERVICE_UNAVAILABLE,
      path: '/api/users?search=[redacted]',
    });
  });

  it('answers any other driver error as an internal error', () => {
    const { status, body } = answer(postgresError('XX000'));
    expect(status).toBe(500);
    expect(body).toMatchObject({ errorCode: ErrorCode.INTERNAL_ERROR });
  });
});
