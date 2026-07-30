import { Logger } from '@nestjs/common';
import type { HealthIndicatorService } from '@nestjs/terminus';
import type { QueueWorkerLivenessService } from '../../../common/queue/heartbeat/queue-worker-liveness.service';
import type { QueueStatusService } from '../../../common/queue/queue-status.service';
import { QueueHealthIndicator } from './queue.health';

// Same security contract as prisma.health.spec.ts, asserted against the other
// indicator sharing `/api/health/*`: both endpoints are @Public(), so a failure
// tells the logs everything and the caller nothing (CWE-209). Two specs rather
// than one because each is the co-located spec of its own source file — but the
// assertions are deliberately parallel, so a future indicator has a shape to
// copy and a drift between the two is visible.
describe('QueueHealthIndicator', () => {
  // A realistic ioredis connection failure — it names the internal host and port.
  const REDIS_CONNECTION_FAILURE =
    'connect ECONNREFUSED 10.0.0.7:6379 while connecting to redis:6379';

  const STALE_AFTER_MILLISECONDS = 15 * 60 * 1000;

  let indicator: QueueHealthIndicator;
  let markUp: jest.Mock;
  let markDown: jest.Mock;
  let verifyQueueConnectivity: jest.Mock;
  let readHeartbeat: jest.Mock;
  let logError: jest.SpyInstance;
  let logWarn: jest.SpyInstance;

  beforeEach(() => {
    logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    logWarn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    markUp = jest.fn().mockReturnValue({ queue: { status: 'up' } });
    markDown = jest.fn().mockReturnValue({ queue: { status: 'down' } });
    verifyQueueConnectivity = jest.fn();
    readHeartbeat = jest.fn();

    indicator = new QueueHealthIndicator(
      { verifyQueueConnectivity } as unknown as QueueStatusService,
      { readHeartbeat } as unknown as QueueWorkerLivenessService,
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

  describe('connectivityCheck', () => {
    it('reports up when every queue answers', async () => {
      verifyQueueConnectivity.mockResolvedValueOnce(undefined);

      await indicator.connectivityCheck('queue');

      expect(markUp).toHaveBeenCalled();
      expect(markDown).not.toHaveBeenCalled();
      expect(logError).not.toHaveBeenCalled();
    });

    it('never leaks the Redis error into the public response', async () => {
      verifyQueueConnectivity.mockRejectedValueOnce(
        new Error(REDIS_CONNECTION_FAILURE),
      );

      await indicator.connectivityCheck('queue');

      const publicPayload = publicFailurePayload();
      expect(publicPayload).not.toContain('10.0.0.7');
      expect(publicPayload).not.toContain('6379');
      expect(publicPayload).not.toContain('ECONNREFUSED');
      expect(markDown).toHaveBeenCalledWith({
        message: 'Queue infrastructure unreachable',
      });
    });

    it('logs the real reason so an outage stays diagnosable', async () => {
      verifyQueueConnectivity.mockRejectedValueOnce(
        new Error(REDIS_CONNECTION_FAILURE),
      );

      await indicator.connectivityCheck('queue');

      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining(REDIS_CONNECTION_FAILURE),
      );
    });

    it('logs the underlying errno when the driver wraps it as a cause', async () => {
      verifyQueueConnectivity.mockRejectedValueOnce(
        new Error('Queue "maintenance" did not respond within 2000ms', {
          cause: Object.assign(new Error(REDIS_CONNECTION_FAILURE), {
            code: 'ECONNREFUSED',
          }),
        }),
      );

      await indicator.connectivityCheck('queue');

      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('ECONNREFUSED'),
      );
      expect(publicFailurePayload()).not.toContain('10.0.0.7');
    });
  });

  describe('workerHeartbeatCheck', () => {
    it('reports up, with the observed instant, when a worker beat recently', async () => {
      const observedAt = new Date('2026-07-30T22:00:00.000Z');
      readHeartbeat.mockResolvedValueOnce({
        observedAt,
        isFresh: true,
        staleAfterMilliseconds: STALE_AFTER_MILLISECONDS,
      });

      await indicator.workerHeartbeatCheck('queue_worker');

      expect(markUp).toHaveBeenCalledWith({
        observedAt: observedAt.toISOString(),
      });
      expect(markDown).not.toHaveBeenCalled();
    });

    // The observed timestamp IS published on the failure path, deliberately: it
    // is not topology, and it is the one thing that makes this endpoint
    // actionable ("stale since when?") without log access.
    it('publishes how stale the heartbeat is, and nothing else', async () => {
      const observedAt = new Date('2026-07-30T20:00:00.000Z');
      readHeartbeat.mockResolvedValueOnce({
        observedAt,
        isFresh: false,
        staleAfterMilliseconds: STALE_AFTER_MILLISECONDS,
      });

      await indicator.workerHeartbeatCheck('queue_worker');

      expect(markDown).toHaveBeenCalledWith({
        message: 'No recent queue worker heartbeat',
        observedAt: observedAt.toISOString(),
      });
      expect(logWarn).toHaveBeenCalledWith(
        expect.stringContaining(observedAt.toISOString()),
      );
    });

    it('reports never-beaten as down with a null instant rather than omitting it', async () => {
      readHeartbeat.mockResolvedValueOnce({
        observedAt: null,
        isFresh: false,
        staleAfterMilliseconds: STALE_AFTER_MILLISECONDS,
      });

      await indicator.workerHeartbeatCheck('queue_worker');

      // Explicit null, not undefined: "no worker has ever beaten" must survive
      // JSON serialization as a stated fact, not vanish into a missing key.
      expect(markDown).toHaveBeenCalledWith({
        message: 'No recent queue worker heartbeat',
        observedAt: null,
      });
      expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('never'));
    });

    it('never leaks the Redis error when the heartbeat read itself fails', async () => {
      readHeartbeat.mockRejectedValueOnce(new Error(REDIS_CONNECTION_FAILURE));

      await indicator.workerHeartbeatCheck('queue_worker');

      expect(markDown).toHaveBeenCalledWith({
        message: 'Queue infrastructure unreachable',
      });
      expect(publicFailurePayload()).not.toContain('10.0.0.7');
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining(REDIS_CONNECTION_FAILURE),
      );
    });
  });
});
