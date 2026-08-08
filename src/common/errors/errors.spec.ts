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
