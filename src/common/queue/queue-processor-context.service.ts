import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { QueueJobHandlerRegistry } from './queue-job-handler.registry';
import { QueueLifecycleLogger } from './queue-lifecycle.logger';

// Everything `QueueProcessor` needs, bundled into one injectable.
//
// Bundled deliberately: a concrete processor is meant to be four lines
// (`super(QueueName.X, context)`), and adding a queue should never mean copying
// a five-parameter constructor. Widening the base class's needs later then
// stays a change to this one file rather than to every processor.
@Injectable()
export class QueueProcessorContext {
  constructor(
    readonly handlerRegistry: QueueJobHandlerRegistry,
    readonly lifecycleLogger: QueueLifecycleLogger,
    readonly clsService: ClsService,
    readonly configService: ConfigService,
  ) {}
}
