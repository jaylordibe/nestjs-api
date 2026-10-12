import { HttpStatus, Logger } from '@nestjs/common';
import type { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AuditEntry, AuditService } from '../audit/audit.service';
import { ErrorCode } from '../errors/error-code.enum';
import {
  OPEN_WINDOW_MILLISECONDS,
  PROVIDER_FAILURE_THRESHOLD,
} from './turnstile-circuit-breaker';
import {
  MAX_TURNSTILE_TOKEN_LENGTH,
  TURNSTILE_BYPASS_AUDIT_ACTION,
  TurnstileService,
} from './turnstile.service';

// The decisions layered on the breaker: which answers are verdicts, which are
// no-answers that feed the bypass, which are our own fault and must keep
// failing closed, and what a bypass records. The breaker's own state machine is
// in turnstile-circuit-breaker.spec.ts.
describe('TurnstileService', () => {
  const startMilliseconds = 1_700_000_000_000;
  const TOKEN = 'a-widget-token';
  let fetchMock: jest.SpyInstance;
  let recordAuditEntry: jest.Mock;
  let service: TurnstileService;

  let cancelBody: jest.Mock;

  function answer(payload: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      body: { cancel: cancelBody },
      json: () => Promise.resolve(payload),
    } as unknown as Response;
  }

  // Every Logger call the service made, for asserting what never reaches a log.
  function loggedText(): string {
    return JSON.stringify(
      (['log', 'warn', 'error'] as const).map(
        (level): unknown[][] =>
          (Logger.prototype[level] as unknown as jest.Mock).mock
            .calls as unknown[][],
      ),
    );
  }

  function unreadableAnswer(): Response {
    return {
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    } as unknown as Response;
  }

  function buildService(
    secrets: { web?: string; mobile?: string } = {
      web: 'web-secret',
      mobile: 'mobile-secret',
    },
  ): TurnstileService {
    return new TurnstileService(
      {
        get: (key: string) =>
          key === 'turnstile.webSecretKey' ? secrets.web : secrets.mobile,
      } as unknown as ConfigService,
      { record: recordAuditEntry } as unknown as AuditService,
    );
  }

  const verify = (widget: 'web' | 'mobile' = 'web') =>
    service.verify(TOKEN, widget, '203.0.113.4');

  async function expectRefusal(
    promise: Promise<unknown>,
    status: HttpStatus,
    errorCode: ErrorCode,
  ): Promise<void> {
    const error = (await promise.then(
      () => {
        throw new Error('expected a refusal');
      },
      (caught: unknown) => caught,
    )) as HttpException;
    expect(error.getStatus()).toBe(status);
    expect(error.getResponse()).toMatchObject({ errorCode });
  }

  const expectUnavailable = (promise: Promise<unknown>) =>
    expectRefusal(
      promise,
      HttpStatus.SERVICE_UNAVAILABLE,
      ErrorCode.EXTERNAL_SERVICE_UNAVAILABLE,
    );

  function sentForm(callIndex = -1): URLSearchParams {
    const [, init] = fetchMock.mock.calls.at(callIndex) as [
      string,
      RequestInit,
    ];
    return init.body as URLSearchParams;
  }

  async function failUntilBypass(): Promise<void> {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    for (let attempt = 1; attempt < PROVIDER_FAILURE_THRESHOLD; attempt += 1) {
      await expectUnavailable(verify());
    }
    await expect(verify()).resolves.toBeUndefined();
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(startMilliseconds);
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    // Refuses by default, so a test that forgets to arrange it can never reach
    // Cloudflare.
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unarranged fetch'));
    cancelBody = jest.fn().mockResolvedValue(undefined);
    recordAuditEntry = jest.fn().mockResolvedValue('audit-log-id');
    service = buildService();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('enablement', () => {
    it('is on with both secrets and off with neither', () => {
      expect(service.isEnabled()).toBe(true);
      expect(buildService({}).isEnabled()).toBe(false);
    });

    it('is off with only one secret, which env validation never allows', () => {
      expect(buildService({ web: 'web-secret' }).isEnabled()).toBe(false);
    });
  });

  describe('the call', () => {
    it("sends the chosen widget's secret, the token and the caller's address", async () => {
      fetchMock.mockResolvedValue(answer({ success: true }));

      await verify('web');
      expect(sentForm().get('secret')).toBe('web-secret');
      expect(sentForm().get('response')).toBe(TOKEN);
      expect(sentForm().get('remoteip')).toBe('203.0.113.4');

      await verify('mobile');
      expect(sentForm().get('secret')).toBe('mobile-secret');
    });

    it('asks once and never retries — a token is single-use', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      await expectUnavailable(verify());
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('refuses a token longer than any genuine one without calling out', async () => {
      await expectRefusal(
        service.verify(
          'x'.repeat(MAX_TURNSTILE_TOKEN_LENGTH + 1),
          'web',
          undefined,
        ),
        HttpStatus.BAD_REQUEST,
        ErrorCode.TURNSTILE_TOKEN_INVALID,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('verdicts', () => {
    it('lets a genuine token through', async () => {
      fetchMock.mockResolvedValue(answer({ success: true }));
      await expect(verify()).resolves.toBeUndefined();
    });

    it.each([
      'invalid-input-response',
      'timeout-or-duplicate',
      'missing-input-response',
    ])(
      'refuses a token Cloudflare rejects (%s) as TURNSTILE_TOKEN_INVALID',
      async (cloudflareCode) => {
        fetchMock.mockResolvedValue(
          answer({ success: false, 'error-codes': [cloudflareCode] }),
        );
        await expectRefusal(
          verify(),
          HttpStatus.BAD_REQUEST,
          ErrorCode.TURNSTILE_TOKEN_INVALID,
        );
      },
    );

    it('keeps Cloudflare codes out of the response', async () => {
      fetchMock.mockResolvedValue(
        answer({ success: false, 'error-codes': ['timeout-or-duplicate'] }),
      );
      const error = (await verify().catch(
        (caught: unknown) => caught,
      )) as HttpException;
      expect(JSON.stringify(error.getResponse())).not.toContain(
        'timeout-or-duplicate',
      );
    });

    it.each(['invalid-input-secret', 'missing-input-secret', 'bad-request'])(
      'answers 503, not "get a new token", when Cloudflare faults our side (%s)',
      async (cloudflareCode) => {
        fetchMock.mockResolvedValue(
          answer({ success: false, 'error-codes': [cloudflareCode] }),
        );
        await expectUnavailable(verify());
      },
    );

    it('accepts only a boolean true as success', async () => {
      fetchMock.mockResolvedValue(answer({ success: 'true' }));
      await expectUnavailable(verify());
    });
  });

  describe('no answer, and the bypass', () => {
    it.each([
      [
        'the call throws',
        () => fetchMock.mockRejectedValue(new TypeError('fetch failed')),
      ],
      [
        'the call times out',
        () =>
          fetchMock.mockRejectedValue(
            new DOMException('timed out', 'TimeoutError'),
          ),
      ],
      [
        'siteverify answers 5xx',
        () => fetchMock.mockResolvedValue(answer({}, 502)),
      ],
      [
        'a 2xx body is unreadable',
        () => fetchMock.mockResolvedValue(unreadableAnswer()),
      ],
      [
        'a 2xx body is not a siteverify answer',
        () => fetchMock.mockResolvedValue(answer({ html: true })),
      ],
      [
        'Cloudflare reports its own internal-error',
        () =>
          fetchMock.mockResolvedValue(
            answer({ success: false, 'error-codes': ['internal-error'] }),
          ),
      ],
    ])(
      'refuses with 503 until the threshold, then bypasses with an audit row (%s)',
      async (_label, arrange) => {
        arrange();
        for (
          let attempt = 1;
          attempt < PROVIDER_FAILURE_THRESHOLD;
          attempt += 1
        ) {
          await expectUnavailable(verify());
        }
        expect(recordAuditEntry).not.toHaveBeenCalled();

        await expect(verify('mobile')).resolves.toBeUndefined();
        expect(recordAuditEntry).toHaveBeenCalledTimes(1);
        const [entry] = recordAuditEntry.mock.calls[0] as [AuditEntry];
        expect(entry).toMatchObject({
          action: TURNSTILE_BYPASS_AUDIT_ACTION,
          actorId: null,
          metadata: { widget: 'mobile' },
        });
        expect(Object.keys(entry.metadata ?? {}).sort()).toEqual([
          'reason',
          'widget',
        ]);
      },
    );

    it('skips the call while the window is open, auditing every bypass, and never records the token', async () => {
      await failUntilBypass();
      fetchMock.mockClear();

      await expect(verify()).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(recordAuditEntry).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(recordAuditEntry.mock.calls)).not.toContain(TOKEN);
    });

    it('never writes the token to a log, refused or bypassed', async () => {
      fetchMock.mockResolvedValue(
        answer({ success: false, 'error-codes': ['invalid-input-response'] }),
      );
      await verify().catch(() => undefined);
      await failUntilBypass();
      await verify();
      expect(loggedText()).not.toContain(TOKEN);
    });

    it('keeps a reply naming a bad token beside internal-error a refused-token verdict', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          answer({
            success: false,
            'error-codes': ['invalid-input-response', 'internal-error'],
          }),
        ),
      );
      for (
        let attempt = 1;
        attempt <= PROVIDER_FAILURE_THRESHOLD * 2;
        attempt += 1
      ) {
        await expectRefusal(
          verify(),
          HttpStatus.BAD_REQUEST,
          ErrorCode.TURNSTILE_TOKEN_INVALID,
        );
      }
      expect(recordAuditEntry).not.toHaveBeenCalled();
    });

    it('never counts internal-error toward the bypass when the reply also blames our secret', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          answer({
            success: false,
            'error-codes': ['internal-error', 'invalid-input-secret'],
          }),
        ),
      );
      for (
        let attempt = 1;
        attempt <= PROVIDER_FAILURE_THRESHOLD * 2;
        attempt += 1
      ) {
        await expectUnavailable(verify());
      }
      expect(recordAuditEntry).not.toHaveBeenCalled();
    });

    it('releases the connection of a reply it does not read', async () => {
      fetchMock.mockResolvedValue(answer({}, 502));
      await expectUnavailable(verify());
      fetchMock.mockResolvedValue(answer({}, 400));
      await expectUnavailable(verify());
      expect(cancelBody).toHaveBeenCalledTimes(2);
    });

    it('starts the count over when Cloudflare answers between no-answers, even only to say our request is wrong', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      for (
        let attempt = 1;
        attempt < PROVIDER_FAILURE_THRESHOLD;
        attempt += 1
      ) {
        await expectUnavailable(verify());
      }
      fetchMock.mockResolvedValueOnce(answer({}, 400));
      await expectUnavailable(verify());

      // A full reset: a whole new run of no-answers is needed again.
      for (
        let attempt = 1;
        attempt < PROVIDER_FAILURE_THRESHOLD;
        attempt += 1
      ) {
        await expectUnavailable(verify());
      }
      expect(recordAuditEntry).not.toHaveBeenCalled();
      await expect(verify()).resolves.toBeUndefined();
      expect(recordAuditEntry).toHaveBeenCalledTimes(1);
    });

    it('refuses a bypassed request whose audit row cannot be written', async () => {
      recordAuditEntry.mockResolvedValue(null);
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      for (
        let attempt = 1;
        attempt <= PROVIDER_FAILURE_THRESHOLD;
        attempt += 1
      ) {
        await expectUnavailable(verify());
      }
      expect(loggedText()).not.toContain('BYPASSED');
    });

    it('asks Cloudflare again once the window passes, and checks normally once it answers', async () => {
      await failUntilBypass();
      jest.setSystemTime(startMilliseconds + OPEN_WINDOW_MILLISECONDS);
      fetchMock.mockResolvedValue(
        answer({ success: false, 'error-codes': ['invalid-input-response'] }),
      );

      await expectRefusal(
        verify(),
        HttpStatus.BAD_REQUEST,
        ErrorCode.TURNSTILE_TOKEN_INVALID,
      );
      expect(fetchMock).toHaveBeenCalled();

      // Closed again: a single later no-answer is refused, not bypassed.
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      await expectUnavailable(verify());
    });

    it.each([
      ['a 4xx', () => answer({}, 400)],
      [
        'an invalid-input-secret verdict',
        () =>
          answer({ success: false, 'error-codes': ['invalid-input-secret'] }),
      ],
    ])(
      'never engages the bypass when Cloudflare says our request is wrong (%s)',
      async (_label, buildAnswer) => {
        fetchMock.mockImplementation(() => Promise.resolve(buildAnswer()));
        for (
          let attempt = 1;
          attempt <= PROVIDER_FAILURE_THRESHOLD * 2;
          attempt += 1
        ) {
          await expectUnavailable(verify());
        }
        expect(recordAuditEntry).not.toHaveBeenCalled();
      },
    );
  });
});
