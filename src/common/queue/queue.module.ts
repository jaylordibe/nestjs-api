import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { DiscoveryModule } from '@nestjs/core';
import { parseRedisConnectionOptions } from '../util/redis-url.util';
import { QueueHeartbeatHandler } from './heartbeat/queue-heartbeat.handler';
import { MaintenanceQueueProcessor } from './processors/maintenance-queue.processor';
import { QueueAccessor } from './queue-accessor.service';
import { QueueWorkerLivenessService } from './heartbeat/queue-worker-liveness.service';
import { RecurringScheduleInstaller } from './recurring-schedule.installer';
import { QueueJobHandlerRegistry } from './queue-job-handler.registry';
import { QueueLifecycleLogger } from './queue-lifecycle.logger';
import { QueueProcessorContext } from './queue-processor-context.service';
import { QueueProducerService } from './queue-producer.service';
import { QueueStatusService } from './queue-status.service';
import {
  DEFAULT_JOB_RETENTION_POLICY,
  REGISTERED_QUEUE_NAMES,
} from './queue-registry';

// ── Shared BullMQ infrastructure ─────────────────────────────────────────────
// Global, like RedisModule, because producing a job is something any module may
// need and threading an import through every feature module would be noise.
//
// Two things this module deliberately does NOT do:
//   - depend on any business module. The dependency only ever runs the other
//     way; a domain module imports nothing from here beyond types, decorators
//     and QueueProducerService.
//   - contain domain logic. The single handler it ships is the infrastructure
//     heartbeat.
//
// See ./README.md for how to register a queue, write a producer, and write a
// handler.
@Global()
@Module({
  imports: [
    // DiscoveryService backs QueueJobHandlerRegistry's boot-time scan for
    // @RegisterQueueJobHandler() providers.
    DiscoveryModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        // Built from REDIS_URL rather than the discrete REDIS_HOST/REDIS_PORT
        // vars because only the URL carries the logical database index, which
        // is what isolates each parallel e2e worker's queue state. See
        // parseRedisConnectionOptions.
        connection: {
          ...parseRedisConnectionOptions(
            configService.getOrThrow<string>('redis.url'),
          ),
          // BullMQ's blocking commands (BRPOPLPUSH and friends) sit on a
          // connection for as long as they wait, so a per-request retry ceiling
          // would tear that connection down mid-wait. ioredis requires null
          // here and BullMQ refuses to start without it.
          maxRetriesPerRequest: null,
        },
        // Every Redis key BullMQ writes is namespaced by the service. Set ONCE
        // here rather than baked into each queue name, so a queue is named for
        // its domain (`maintenance`) and nothing has to remember to prefix it.
        // Environments need no segment of their own — dev, test, staging and
        // production each point at a physically separate Redis instance.
        prefix: configService.getOrThrow<string>('serviceName'),
        defaultJobOptions: {
          // A floor, not the operative policy: QueueProducerService resolves
          // the real retry/retention options per job. This only stops a job
          // enqueued by some future path that bypasses the producer from
          // retaining forever.
          removeOnComplete: {
            count: DEFAULT_JOB_RETENTION_POLICY.completedCount,
            age: DEFAULT_JOB_RETENTION_POLICY.completedAgeSeconds,
          },
          removeOnFail: {
            count: DEFAULT_JOB_RETENTION_POLICY.failedCount,
            age: DEFAULT_JOB_RETENTION_POLICY.failedAgeSeconds,
          },
        },
      }),
    }),
    // One registration per declared queue — adding a queue to the registry is
    // enough, no edit here.
    ...REGISTERED_QUEUE_NAMES.map((queueName) =>
      BullModule.registerQueue({ name: queueName }),
    ),
  ],
  providers: [
    QueueAccessor,
    QueueLifecycleLogger,
    QueueProducerService,
    QueueStatusService,
    QueueJobHandlerRegistry,
    QueueProcessorContext,
    // Processors are registered unconditionally and started conditionally —
    // each is declared `autorun: false` and only calls run() when
    // QUEUE_WORKER_ENABLED is true. Gating the PROVIDER instead would mean
    // reading env outside configuration.ts, since a module's provider list is
    // fixed before ConfigService exists.
    MaintenanceQueueProcessor,
    QueueHeartbeatHandler,
    QueueWorkerLivenessService,
    RecurringScheduleInstaller,
  ],
  // BullModule is re-exported so consumers (e.g. e2e specs and the health
  // module) can inject a queue by token without re-registering it.
  //
  // QueueAccessor is deliberately NOT exported. It hands out raw BullMQ
  // `Queue` objects, and advertising that to every module in a @Global() module
  // would invite domain code to bypass the producer — losing the retry,
  // retention and lifecycle-logging guarantees resolved there.
  exports: [
    BullModule,
    QueueProducerService,
    QueueStatusService,
    QueueWorkerLivenessService,
  ],
})
export class QueueModule {}
