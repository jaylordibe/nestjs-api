import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import {
  QUEUE_JOB_HANDLER_METADATA,
  type QueueJobHandler,
} from './queue-job-handler';
import {
  JOB_REGISTRATIONS,
  REGISTERED_JOB_NAMES,
  type JobName,
} from './job-registry';
import { QueueProcessor } from './queue-processor.base';
import { REGISTERED_QUEUE_NAMES } from './queue-registry';

// Resolves `job.name` → the handler that runs it.
//
// The boot-time completeness check is the guardrail that makes the job registry
// self-enforcing: a job declared in JOB_REGISTRATIONS with no handler, or two
// handlers claiming the same job, crashes the process at startup rather than
// failing the first time that job is enqueued in production. Documentation
// alone would not survive the second contributor.
@Injectable()
export class QueueJobHandlerRegistry implements OnApplicationBootstrap {
  private readonly logger = new Logger(QueueJobHandlerRegistry.name);
  private readonly handlersByJobName = new Map<JobName, QueueJobHandler>();

  constructor(private readonly discoveryService: DiscoveryService) {}

  onApplicationBootstrap(): void {
    for (const wrapper of this.discoveryService.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (!instance || typeof instance !== 'object') {
        continue;
      }
      const isQueueJobHandler = Reflect.getMetadata(
        QUEUE_JOB_HANDLER_METADATA,
        instance.constructor,
      ) as boolean | undefined;
      if (!isQueueJobHandler) {
        continue;
      }

      const handler = instance as QueueJobHandler;
      const existingHandler = this.handlersByJobName.get(handler.jobName);
      // Compared by IDENTITY, not by presence. DiscoveryService returns one
      // wrapper per provider registration, so an alias (`useExisting`) or a
      // handler listed in two modules yields the same instance twice — which is
      // not a conflict, and reporting it as one would crash the app at boot
      // with "Two handlers claim x: SomeHandler and SomeHandler".
      if (existingHandler && existingHandler !== handler) {
        throw new Error(
          `Two queue job handlers claim "${handler.jobName}": ${existingHandler.constructor.name} and ${handler.constructor.name}`,
        );
      }
      this.handlersByJobName.set(handler.jobName, handler);
    }

    const jobNamesWithoutHandler = REGISTERED_JOB_NAMES.filter(
      (jobName) => !this.handlersByJobName.has(jobName),
    );
    if (jobNamesWithoutHandler.length > 0) {
      throw new Error(
        `Registered queue jobs have no handler: ${jobNamesWithoutHandler.join(', ')}. Add a @RegisterQueueJobHandler() provider, or drop the job from JOB_REGISTRATIONS.`,
      );
    }

    this.verifyEveryQueueHasAProcessor();

    this.logger.log(
      `Resolved ${this.handlersByJobName.size} queue job handler(s) across ${
        new Set(
          REGISTERED_JOB_NAMES.map(
            (jobName) => JOB_REGISTRATIONS[jobName].queueName,
          ),
        ).size
      } queue(s)`,
    );
  }

  findByJobName(jobName: JobName): QueueJobHandler | undefined {
    return this.handlersByJobName.get(jobName);
  }

  // The coarser half of the wiring check. A job with no handler already crashes
  // the process above; a whole QUEUE with no processor did not, and that is the
  // more dangerous of the two — every other signal stays green. The queue
  // registers, producers enqueue successfully, `verifyQueueConnectivity`
  // reports it healthy because job counts read fine, and the heartbeat only
  // proves the MAINTENANCE queue's worker is alive. The jobs simply pile up
  // forever with nothing consuming them.
  private verifyEveryQueueHasAProcessor(): void {
    const consumedQueueNames = new Set(
      this.discoveryService
        .getProviders()
        .map((wrapper) => wrapper.instance as unknown)
        .filter(
          (instance): instance is QueueProcessor =>
            instance instanceof QueueProcessor,
        )
        .map((processor) => processor.consumedQueueName),
    );

    const queueNamesWithoutProcessor = REGISTERED_QUEUE_NAMES.filter(
      (queueName) => !consumedQueueNames.has(queueName),
    );
    if (queueNamesWithoutProcessor.length > 0) {
      throw new Error(
        `Registered queues have no processor: ${queueNamesWithoutProcessor.join(', ')}. Add a QueueProcessor subclass decorated with @ProcessesQueue(), and register it in QueueModule — or drop the queue from QUEUE_REGISTRATIONS.`,
      );
    }
  }
}
