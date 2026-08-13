import { Logger } from '@nestjs/common';
import type { HealthIndicatorService } from '@nestjs/terminus';
import type { PrismaService } from '../../../prisma/prisma.service';
import { PrismaHealthIndicator } from './prisma.health';

// The contract under test is a security one: `/api/health/readiness` is
// @Public(), so the failure path must reveal the reason to the logs and nothing
// but a fixed string to the caller. See queue.health.spec.ts for the same
// contract asserted against the other indicator on that endpoint — the two must
// not drift.
describe('PrismaHealthIndicator', () => {
  // A realistic Prisma P1000 — it names the internal host AND the database user.
  const PRISMA_AUTH_FAILURE =
    'Authentication failed against database server at `postgres`, the provided database credentials for `nestjs` are not valid';

  let indicator: PrismaHealthIndicator;
  let markUp: jest.Mock;
  let markDown: jest.Mock;
  let runRawQuery: jest.Mock;
  let logError: jest.SpyInstance;

  beforeEach(() => {
    logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    markUp = jest.fn().mockReturnValue({ database: { status: 'up' } });
    markDown = jest.fn().mockReturnValue({ database: { status: 'down' } });
    runRawQuery = jest.fn();

    indicator = new PrismaHealthIndicator(
      { $queryRaw: runRawQuery } as unknown as PrismaService,
      {
        check: () => ({ up: markUp, down: markDown }),
      } as unknown as HealthIndicatorService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  // Serialized form of what the indicator handed back to terminus — i.e. exactly
  // what an unauthenticated caller would receive.
  function publicFailurePayload(): string {
    const downCalls = markDown.mock.calls as unknown as Array<[unknown]>;
    return JSON.stringify(downCalls[0]?.[0]);
  }

  it('reports up when the database answers', async () => {
    runRawQuery.mockResolvedValueOnce([{ '?column?': 1 }]);

    await indicator.pingCheck('database');

    expect(markUp).toHaveBeenCalled();
    expect(markDown).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it('never leaks the driver error into the public response', async () => {
    runRawQuery.mockRejectedValueOnce(new Error(PRISMA_AUTH_FAILURE));

    await indicator.pingCheck('database');

    const publicPayload = publicFailurePayload();
    expect(publicPayload).not.toContain('postgres');
    expect(publicPayload).not.toContain('nestjs');
    expect(publicPayload).not.toContain('credentials');
    expect(markDown).toHaveBeenCalledWith({ message: 'Database unreachable' });
  });

  it('logs the real reason so an outage stays diagnosable', async () => {
    runRawQuery.mockRejectedValueOnce(new Error(PRISMA_AUTH_FAILURE));

    await indicator.pingCheck('database');

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining(PRISMA_AUTH_FAILURE),
    );
  });

  // The failure mode this bound exists for: the socket is established, so the
  // pool's own connection timeout never applies, and the query simply never
  // answers. Unbounded, the readiness endpoint would hang instead of reporting
  // 503 — terminus applies no deadline of its own to a custom indicator.
  describe('when the database accepts the query but never answers', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('fails the check rather than hanging the readiness endpoint', async () => {
      runRawQuery.mockReturnValueOnce(new Promise(() => undefined));

      const pending = indicator.pingCheck('database');
      await jest.advanceTimersByTimeAsync(2_000);
      await pending;

      expect(markDown).toHaveBeenCalledWith({
        message: 'Database unreachable',
      });
      expect(markUp).not.toHaveBeenCalled();
    });

    it('keeps the timeout budget out of the public payload but in the logs', async () => {
      runRawQuery.mockReturnValueOnce(new Promise(() => undefined));

      const pending = indicator.pingCheck('database');
      await jest.advanceTimersByTimeAsync(2_000);
      await pending;

      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('did not answer within'),
      );
      expect(publicFailurePayload()).not.toContain('did not answer');
    });
  });

  it('logs the underlying errno when the driver wraps it as a cause', async () => {
    runRawQuery.mockRejectedValueOnce(
      new Error('Cannot connect to database', {
        cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), {
          code: 'ECONNREFUSED',
        }),
      }),
    );

    await indicator.pingCheck('database');

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('ECONNREFUSED'),
    );
    // ...while the address it exposes stays out of the public payload.
    expect(publicFailurePayload()).not.toContain('10.0.0.5');
  });
});
