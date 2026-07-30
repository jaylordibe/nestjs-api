import { Logger } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import {
  QueueLifecycleEvent,
  QueueLifecycleLogger,
} from './queue-lifecycle.logger';
import { QueueName } from './queue-registry';

// `PinoLogger.root` is declared `static readonly`, so it is replaced through
// defineProperty rather than assignment. Each test installs the level policy it
// needs and the afterEach puts the original back.
function stubRootLogger(rootLogger: unknown): void {
  Object.defineProperty(PinoLogger, 'root', {
    value: rootLogger,
    configurable: true,
    writable: true,
  });
}

// The spy's `mock.calls` is `any[][]`, so the argument list is narrowed once
// here rather than with an unchecked assertion at each assertion site.
function firstLoggedLine(spy: jest.SpyInstance): string {
  const [firstCallArguments] = spy.mock.calls as unknown[][];
  return String(firstCallArguments?.[0]);
}

describe('QueueLifecycleLogger', () => {
  const originalRootLogger = PinoLogger.root;
  let lifecycleLogger: QueueLifecycleLogger;
  let debugSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    lifecycleLogger = new QueueLifecycleLogger();
    debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    stubRootLogger(originalRootLogger);
  });

  const record = (event: QueueLifecycleEvent) =>
    lifecycleLogger.record({
      event,
      queueName: QueueName.MAINTENANCE,
      jobName: 'maintenance.queue-heartbeat.v1',
      jobId: 'job-1',
    });

  describe('level routing', () => {
    beforeEach(() => {
      stubRootLogger({ isLevelEnabled: () => true });
    });

    it('sends failures to error', () => {
      record(QueueLifecycleEvent.FAILED);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('sends retries to warn — a retry is not yet a failure', () => {
      record(QueueLifecycleEvent.RETRIED);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('sends the per-job started line to debug', () => {
      record(QueueLifecycleEvent.STARTED);
      expect(debugSpy).toHaveBeenCalledTimes(1);
    });

    it.each([
      QueueLifecycleEvent.SCHEDULED,
      QueueLifecycleEvent.ENQUEUED,
      QueueLifecycleEvent.COMPLETED,
      QueueLifecycleEvent.SKIPPED,
      QueueLifecycleEvent.CANCELLED,
      QueueLifecycleEvent.RESCHEDULED,
    ])('sends %s to info', (event) => {
      record(event);
      expect(logSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('level guard', () => {
    it('emits nothing when the target level is disabled', () => {
      // Production sits at info, so the per-job `started` line is discarded —
      // and must not be formatted first, which is the whole point of the guard.
      stubRootLogger({ isLevelEnabled: (level: string) => level !== 'debug' });

      record(QueueLifecycleEvent.STARTED);
      expect(debugSpy).not.toHaveBeenCalled();

      // The levels that ARE enabled still come through.
      record(QueueLifecycleEvent.COMPLETED);
      expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it('asks pino, not the Nest logger, which level is enabled', () => {
      const isLevelEnabled = jest.fn().mockReturnValue(true);
      stubRootLogger({ isLevelEnabled });

      record(QueueLifecycleEvent.STARTED);

      // `Logger.isLevelEnabled` from @nestjs/common reads Nest's own static
      // levels, which nothing here configures — it would answer "debug is on"
      // while pino sits at info. The guard has to consult pino itself.
      expect(isLevelEnabled).toHaveBeenCalledWith('debug');
    });

    it('fails OPEN when no root logger is available', () => {
      // A unit test that never bootstrapped LoggerModule. Losing a failure line
      // to an over-clever optimisation is far worse than formatting a string
      // nobody reads.
      stubRootLogger(undefined);
      record(QueueLifecycleEvent.FAILED);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('fails OPEN when the root logger has no level check', () => {
      stubRootLogger({});
      record(QueueLifecycleEvent.FAILED);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('formatting', () => {
    beforeEach(() => {
      stubRootLogger({ isLevelEnabled: () => true });
    });

    it('renders logfmt and omits absent fields', () => {
      lifecycleLogger.record({
        event: QueueLifecycleEvent.COMPLETED,
        queueName: QueueName.MAINTENANCE,
        jobName: 'maintenance.queue-heartbeat.v1',
        jobId: 'job-1',
        durationMilliseconds: 4,
      });

      const line = firstLoggedLine(logSpy);
      expect(line).toBe(
        'event=completed queue=maintenance job=maintenance.queue-heartbeat.v1 jobId=job-1 durationMs=4',
      );
      expect(line).not.toContain('attempt=');
    });

    it('quotes a reason containing whitespace so the line stays parseable', () => {
      lifecycleLogger.record({
        event: QueueLifecycleEvent.SKIPPED,
        queueName: QueueName.MAINTENANCE,
        jobName: 'maintenance.queue-heartbeat.v1',
        reason: 'superseded by a newer schedule',
      });

      expect(firstLoggedLine(logSpy)).toContain(
        'reason="superseded by a newer schedule"',
      );
    });
  });
});
