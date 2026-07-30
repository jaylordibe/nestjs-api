import { QueueProcessorContext } from '../queue-processor-context.service';
import { ProcessesQueue, QueueProcessor } from '../queue-processor.base';
import { QueueName } from '../queue-registry';

// One of these per registered queue — the whole cost of adding a queue, on top
// of its registry entry.
//
// `@ProcessesQueue` rather than a bare `@Processor` — it carries the
// `autorun: false` that leaves `QueueProcessor.onApplicationBootstrap` to
// decide from QUEUE_WORKER_ENABLED whether this process consumes or only
// produces.
@ProcessesQueue(QueueName.MAINTENANCE)
export class MaintenanceQueueProcessor extends QueueProcessor {
  constructor(context: QueueProcessorContext) {
    super(QueueName.MAINTENANCE, context);
  }
}
