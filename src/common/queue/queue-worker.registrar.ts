import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiscoveryService } from '@nestjs/core';
import { BullRegistrar } from '@nestjs/bullmq';
import { QueueProcessor } from './queue-processor.base';

// Decides whether THIS process consumes BullMQ jobs, and is the only thing that
// does.
//
// `QueueModule` sets `manualRegistration: true` on the BullMQ root, which stops
// `@nestjs/bullmq`'s explorer from constructing Workers during its own
// `onModuleInit`. Nothing consumes until `BullRegistrar.register()` is called,
// and this class is the only caller.
//
// That is a stronger boundary than gating consumption after the fact. The API
// runtime does not construct a Worker, does not open the Redis connection a
// Worker needs, and has nothing to close — where the previous approach built
// every Worker and immediately closed it again, which worked but left an
// object whose existence had to be explained.
//
// Queue PRODUCERS are unaffected: queue providers come from
// `BullModule.registerQueue`, not from the explorer, so an API instance still
// enqueues everything. Producing is never gated; only consuming.
//
// The paired half of the runtime split is `RecurringScheduleInstaller`, gated on
// the same flag: a runtime that does not consume must also not reconcile the
// schedulers, because reconciliation removes what the running release does not
// declare.
@Injectable()
export class QueueWorkerRegistrar implements OnApplicationBootstrap {
  private readonly logger = new Logger(QueueWorkerRegistrar.name);
  // Workers this process actually constructed. Empty in the API runtime, which
  // is what makes `drainWorkers()` a safe no-op there — `WorkerHost.worker`
  // throws when registration never ran, so it must not be touched blindly.
  private readonly startedProcessors: QueueProcessor[] = [];

  constructor(
    private readonly bullRegistrar: BullRegistrar,
    private readonly discoveryService: DiscoveryService,
    private readonly configService: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.configService.getOrThrow<boolean>('queue.workerEnabled')) {
      this.logger.log(
        'Worker disabled by configuration — this process enqueues jobs and constructs no BullMQ worker at all',
      );
      return;
    }

    // Constructs the Workers the explorer found. They are created with
    // `autorun: false` (see `ProcessesQueue`), so none of them has taken a job
    // yet when the loop below configures them.
    this.bullRegistrar.register();

    const processors = this.discoveryService
      .getProviders()
      .map((wrapper) => wrapper.instance as unknown)
      .filter(
        (instance): instance is QueueProcessor =>
          instance instanceof QueueProcessor,
      );

    for (const processor of processors) {
      processor.startConsuming();
      this.startedProcessors.push(processor);
    }

    this.logger.log(
      `Queue worker registered — consuming ${processors.length} queue(s)`,
    );
  }

  /**
   * Stops consuming and waits for in-flight jobs, BEFORE anything else shuts
   * down.
   *
   * Ordering is the whole point. Nest runs `onModuleDestroy` (Prisma
   * `$disconnect()` ends the pg pool; Redis `quit()`) before
   * `onApplicationShutdown`, which is where `@nestjs/bullmq` closes its
   * workers — so relying on the framework alone drains jobs against a database
   * connection that has already gone. A handler mid-transaction would fail on
   * its next query during what is supposed to be a graceful stop.
   *
   * `worker.close()` waits for active jobs to finish, so the caller bounds it
   * (see `src/worker.ts`). A no-op in a runtime that never registered.
   */
  async drainWorkers(): Promise<void> {
    if (this.startedProcessors.length === 0) {
      return;
    }
    this.logger.log(
      `Draining ${this.startedProcessors.length} queue worker(s) before shutdown`,
    );
    await Promise.all(
      this.startedProcessors.map((processor) => processor.worker.close()),
    );
    this.logger.log('Queue workers drained');
  }
}
