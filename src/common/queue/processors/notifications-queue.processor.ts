import { QueueProcessorContext } from '../queue-processor-context.service';
import { ProcessesQueue, QueueProcessor } from '../queue-processor.base';
import { QueueName } from '../queue-registry';

@ProcessesQueue(QueueName.NOTIFICATIONS)
export class NotificationsQueueProcessor extends QueueProcessor {
  constructor(context: QueueProcessorContext) {
    super(QueueName.NOTIFICATIONS, context);
  }
}
