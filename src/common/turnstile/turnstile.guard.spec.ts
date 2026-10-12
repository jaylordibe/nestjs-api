import { HttpStatus } from '@nestjs/common';
import type { ExecutionContext, HttpException } from '@nestjs/common';
import { ErrorCode } from '../errors/error-code.enum';
import { TurnstileGuard } from './turnstile.guard';
import type { TurnstileService } from './turnstile.service';

describe('TurnstileGuard', () => {
  let isEnabled: jest.Mock;
  let verify: jest.Mock;
  let guard: TurnstileGuard;

  function contextWith(headers: Record<string, string>): ExecutionContext {
    const request = {
      ip: '203.0.113.4',
      header: (name: string) => headers[name.toLowerCase()],
    };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    isEnabled = jest.fn().mockReturnValue(true);
    verify = jest.fn().mockResolvedValue(undefined);
    guard = new TurnstileGuard({
      isEnabled,
      verify,
    } as unknown as TurnstileService);
  });

  it('verifies a request with a browser Origin against the web widget', async () => {
    await expect(
      guard.canActivate(
        contextWith({
          origin: 'https://www.lysta.io',
          'x-turnstile-token': 'token',
        }),
      ),
    ).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith('token', 'web', '203.0.113.4');
  });

  it('verifies a request with no Origin against the app widget — never skips it', async () => {
    await guard.canActivate(contextWith({ 'x-turnstile-token': 'token' }));
    expect(verify).toHaveBeenCalledWith('token', 'mobile', '203.0.113.4');
  });

  it.each([{}, { 'x-turnstile-token': '   ' }])(
    'refuses a missing or blank token before asking Cloudflare',
    async (headers) => {
      const error = (await guard
        .canActivate(contextWith(headers))
        .catch((caught: unknown) => caught)) as HttpException;
      expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(error.getResponse()).toMatchObject({
        errorCode: ErrorCode.TURNSTILE_TOKEN_MISSING,
      });
      expect(verify).not.toHaveBeenCalled();
    },
  );

  it('lets everything through when the check is off', async () => {
    isEnabled.mockReturnValue(false);
    await expect(guard.canActivate(contextWith({}))).resolves.toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });
});
