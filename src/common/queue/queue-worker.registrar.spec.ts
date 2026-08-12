import type { ConfigService } from '@nestjs/config';
import type { DiscoveryService } from '@nestjs/core';
import type { BullRegistrar } from '@nestjs/bullmq';
import { QueueWorkerRegistrar } from './queue-worker.registrar';
import { QueueProcessor } from './queue-processor.base';
import { QueueName } from './queue-registry';
import type { QueueProcessorContext } from './queue-processor-context.service';

// The gate that decides whether a process consumes BullMQ jobs.
//
// It replaced a version that constructed every Worker and then closed the ones
// it did not want, so the property under test changed shape: it is no longer
// "the worker is stopped" but "`BullRegistrar.register()` was never called", and
// therefore no Worker exists to stop. Driven as a unit because the e2e can only
// observe the consequence, not the decision.
describe('QueueWorkerRegistrar', () => {
  class TestProcessor extends QueueProcessor {
    startConsumingCallCount = 0;

    constructor() {
      super(QueueName.MAINTENANCE, {} as QueueProcessorContext);
    }

    // Overridden so the test never touches `this.worker`, which does not exist
    // until registration has run — exactly the condition being asserted.
    override startConsuming(): void {
      this.startConsumingCallCount += 1;
    }
  }

  function buildRegistrar(isWorkerEnabled: boolean) {
    const registerCalls: number[] = [];
    const processor = new TestProcessor();

    const bullRegistrar = {
      register: () => {
        registerCalls.push(1);
      },
    } as unknown as BullRegistrar;

    const discoveryService = {
      getProviders: () => [{ instance: processor }, { instance: null }],
    } as unknown as DiscoveryService;

    const configService = {
      getOrThrow: () => isWorkerEnabled,
    } as unknown as ConfigService;

    return {
      registrar: new QueueWorkerRegistrar(
        bullRegistrar,
        discoveryService,
        configService,
      ),
      registerCalls,
      processor,
    };
  }

  describe('with QUEUE_WORKER_ENABLED=false (the API runtime)', () => {
    // The whole point of `manualRegistration: true`: not calling register()
    // means @nestjs/bullmq never constructs a Worker, so the API opens no Redis
    // connection for one and has nothing to close.
    it('never registers BullMQ workers', () => {
      const { registrar, registerCalls } = buildRegistrar(false);

      registrar.onApplicationBootstrap();

      expect(registerCalls).toEqual([]);
    });

    it('starts no processor consuming', () => {
      const { registrar, processor } = buildRegistrar(false);

      registrar.onApplicationBootstrap();

      expect(processor.startConsumingCallCount).toBe(0);
    });
  });

  describe('with QUEUE_WORKER_ENABLED=true (the worker runtime)', () => {
    it('registers the BullMQ workers exactly once', () => {
      const { registrar, registerCalls } = buildRegistrar(true);

      registrar.onApplicationBootstrap();

      expect(registerCalls).toEqual([1]);
    });

    it('starts every discovered processor consuming', () => {
      const { registrar, processor } = buildRegistrar(true);

      registrar.onApplicationBootstrap();

      expect(processor.startConsumingCallCount).toBe(1);
    });

    // Registration must precede configuration: a Worker does not exist before
    // register(), and one that autoran would already have taken a job by the
    // time concurrency and the error listeners were attached.
    it('registers before it starts any processor', () => {
      const observedOrder: string[] = [];
      const processor = new TestProcessor();
      processor.startConsuming = () => observedOrder.push('startConsuming');

      const registrar = new QueueWorkerRegistrar(
        {
          register: () => observedOrder.push('register'),
        } as unknown as BullRegistrar,
        {
          getProviders: () => [{ instance: processor }],
        } as unknown as DiscoveryService,
        { getOrThrow: () => true } as unknown as ConfigService,
      );

      registrar.onApplicationBootstrap();

      expect(observedOrder).toEqual(['register', 'startConsuming']);
    });

    // DiscoveryService returns a wrapper per provider, many with no instance.
    it('tolerates providers with no instance', () => {
      const { registrar } = buildRegistrar(true);

      expect(() => registrar.onApplicationBootstrap()).not.toThrow();
    });
  });
});
