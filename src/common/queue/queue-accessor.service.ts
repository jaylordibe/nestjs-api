import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { formatErrorMessage } from '../util/error-message.util';
import { QueueName, REGISTERED_QUEUE_NAMES } from './queue-registry';

// The single place that knows how a `QueueName` becomes a live BullMQ `Queue`.
//
// Resolution goes through ModuleRef rather than a constructor full of
// `@InjectQueue()` parameters so that registering a new queue stays a one-line
// registry edit — with constructor injection, every queue added would also mean
// editing the producer, the status service and anything else holding a queue.
@Injectable()
export class QueueAccessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(QueueAccessor.name);
  private isShuttingDown = false;

  constructor(private readonly moduleRef: ModuleRef) {}

  // A BullMQ `Queue` is an EventEmitter, and Node's EventEmitter THROWS on an
  // `error` event with no listener. So a connection dropping — a Redis
  // failover, or simply the app closing with a command in flight — would
  // surface as an unhandled error from deep inside BullMQ rather than a log
  // line, with the potential to take the process down.
  //
  // Attaching one listener per queue at bootstrap turns that into a warning
  // that names the queue. Suppressed during shutdown, where a closed connection
  // is the expected outcome rather than a fault worth reporting.
  onApplicationBootstrap(): void {
    for (const queueName of REGISTERED_QUEUE_NAMES) {
      this.getQueue(queueName).on('error', (error) => {
        if (this.isShuttingDown) {
          return;
        }
        this.logger.warn(
          `Queue "${queueName}" connection error: ${formatErrorMessage(error)}`,
        );
      });
    }
  }

  onModuleDestroy(): void {
    this.isShuttingDown = true;
  }

  getQueue(queueName: QueueName): Queue {
    // `strict: false` because the queue providers are registered by
    // BullModule inside QueueModule, not in whichever module is asking.
    return this.moduleRef.get<Queue>(getQueueToken(queueName), {
      strict: false,
    });
  }
}
