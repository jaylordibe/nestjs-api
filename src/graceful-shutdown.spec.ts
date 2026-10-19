import type { INestApplicationContext } from '@nestjs/common';
import type { Logger } from 'nestjs-pino';
import { QueueWorkerRegistrar } from './common/queue/queue-worker.registrar';
import {
  registerShutdownHandlers,
  SHUTDOWN_TIMEOUT_MILLISECONDS,
  shutDownGracefully,
} from './graceful-shutdown';
import { stopTelemetry } from './telemetry';

jest.mock('./telemetry', () => ({ stopTelemetry: jest.fn() }));

describe('shutDownGracefully', () => {
  it('drains queue jobs before the context closes, and flushes telemetry last', async () => {
    const steps: string[] = [];
    jest.mocked(stopTelemetry).mockImplementation(() => {
      steps.push('telemetry');
      return Promise.resolve();
    });
    const registrar = {
      drainWorkers: jest.fn(() => {
        steps.push('drain');
        return Promise.resolve();
      }),
    };
    const applicationContext = {
      get: jest.fn((token: unknown) => {
        expect(token).toBe(QueueWorkerRegistrar);
        return registrar;
      }),
      close: jest.fn(() => {
        steps.push('close');
        return Promise.resolve();
      }),
    } as unknown as INestApplicationContext;

    await shutDownGracefully(applicationContext);

    expect(steps).toEqual(['drain', 'close', 'telemetry']);
  });

  it('does not close the context while a job is still draining', async () => {
    let finishDrain: () => void = () => undefined;
    const close = jest.fn(() => Promise.resolve());
    const applicationContext = {
      get: () => ({
        drainWorkers: () =>
          new Promise<void>((resolve) => {
            finishDrain = resolve;
          }),
      }),
      close,
    } as unknown as INestApplicationContext;

    const shutdown = shutDownGracefully(applicationContext);
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();

    finishDrain();
    await shutdown;
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('registerShutdownHandlers', () => {
  const logger = { log: jest.fn(), error: jest.fn() } as unknown as Logger;
  let exit: jest.SpyInstance;
  let listenersBefore: Record<
    'SIGTERM' | 'SIGINT',
    Set<NodeJS.SignalsListener>
  >;

  const contextWith = (
    drainWorkers: () => Promise<void>,
    close: () => Promise<void> = () => Promise.resolve(),
  ) =>
    ({
      get: () => ({ drainWorkers }),
      close: jest.fn(close),
    }) as unknown as INestApplicationContext;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.mocked(stopTelemetry).mockResolvedValue(undefined);
    exit = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    listenersBefore = {
      SIGTERM: new Set(process.listeners('SIGTERM')),
      SIGINT: new Set(process.listeners('SIGINT')),
    };
  });

  afterEach(() => {
    // Only the listeners this test added, never Jest's own.
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      for (const listener of process.listeners(signal)) {
        if (!listenersBefore[signal].has(listener))
          process.removeListener(signal, listener);
      }
    }
    exit.mockRestore();
    jest.useRealTimers();
  });

  // Lets the promise chain started by a signal run to its end.
  const settle = async () => {
    for (let step = 0; step < 10; step += 1) await Promise.resolve();
  };

  const signal = (name: 'SIGTERM' | 'SIGINT') => {
    for (const listener of process.listeners(name)) {
      if (!listenersBefore[name].has(listener)) listener(name);
    }
  };

  it('exits 0 once the sequence finishes', async () => {
    const context = contextWith(() => Promise.resolve());
    registerShutdownHandlers(context, logger, 'Test');
    signal('SIGTERM');
    await settle();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 1 when the sequence fails', async () => {
    const context = contextWith(() => Promise.reject(new Error('redis gone')));
    registerShutdownHandlers(context, logger, 'Test');
    signal('SIGINT');
    await settle();
    expect(exit).toHaveBeenCalledWith(1);
    expect(exit).not.toHaveBeenCalledWith(0);
  });

  it('exits 1 at the budget when a drain never finishes', () => {
    const context = contextWith(() => new Promise<void>(() => undefined));
    registerShutdownHandlers(context, logger, 'Test');
    signal('SIGTERM');
    jest.advanceTimersByTime(SHUTDOWN_TIMEOUT_MILLISECONDS - 1);
    expect(exit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('runs the sequence once however many signals arrive', () => {
    const drainWorkers = jest.fn(() => new Promise<void>(() => undefined));
    registerShutdownHandlers(contextWith(drainWorkers), logger, 'Test');
    signal('SIGTERM');
    signal('SIGTERM');
    signal('SIGINT');
    expect(drainWorkers).toHaveBeenCalledTimes(1);
  });
});
