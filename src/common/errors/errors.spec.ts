import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from './error-code.enum';
import { Errors } from './errors';

// `rateLimited` is the one factory that constructs a raw `HttpException` rather
// than a semantic Nest subclass, because Nest ships none for 429. That makes it
// the factory most likely to drift out of the envelope shape every other error
// in this API guarantees, and the only one whose payload nothing else asserts.
describe('Errors.rateLimited', () => {
  it('carries 429 and the stable RATE_LIMITED code', () => {
    const exception = Errors.rateLimited();

    expect(exception.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(exception.getResponse()).toMatchObject({
      errorCode: ErrorCode.RATE_LIMITED,
    });
  });

  it('accepts a caller message and defaults to a generic one', () => {
    expect(Errors.rateLimited('Slow down.').getResponse()).toMatchObject({
      errorCode: ErrorCode.RATE_LIMITED,
      message: 'Slow down.',
    });

    const response = Errors.rateLimited().getResponse() as { message: string };
    expect(typeof response.message).toBe('string');
    expect(response.message.length).toBeGreaterThan(0);
  });
});

// The two Turnstile refusals are 400s a client branches on by code alone; the
// rejected one deliberately carries no `details`, so Cloudflare's own error
// codes never become part of this contract.
describe('Errors.turnstileToken*', () => {
  it.each([
    [Errors.turnstileTokenMissing(), ErrorCode.TURNSTILE_TOKEN_MISSING],
    [Errors.turnstileTokenInvalid(), ErrorCode.TURNSTILE_TOKEN_INVALID],
  ])('carries 400, its code and no details', (exception, errorCode) => {
    expect(exception.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(exception.getResponse()).toMatchObject({ errorCode });
    expect(exception.getResponse()).not.toHaveProperty('details');
  });
});

// The three stored-file codes are a client contract: each must carry its
// status and code, and the quota must say what the limit is.
describe('Errors.file*', () => {
  it.each([
    [
      Errors.fileNotAttachable(),
      HttpStatus.CONFLICT,
      ErrorCode.FILE_NOT_ATTACHABLE,
    ],
    [
      Errors.fileContentInvalid('The image could not be decoded.'),
      HttpStatus.UNPROCESSABLE_ENTITY,
      ErrorCode.FILE_CONTENT_INVALID,
    ],
    [
      Errors.fileQuotaExceeded(20),
      HttpStatus.TOO_MANY_REQUESTS,
      ErrorCode.FILE_QUOTA_EXCEEDED,
    ],
  ])('carries its status and code', (exception, status, errorCode) => {
    expect(exception.getStatus()).toBe(status);
    expect(exception.getResponse()).toMatchObject({ errorCode });
  });

  it('names the quota limit in details', () => {
    expect(Errors.fileQuotaExceeded(20).getResponse()).toMatchObject({
      details: { limit: 20 },
    });
  });
});
