import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { formatErrorMessage } from '../util/error-message.util';
import { QueueProducerService } from './queue-producer.service';
import { REGISTERED_QUEUE_NAMES } from './queue-registry';
import {
  RECURRING_SCHEDULES,
  REGISTERED_SCHEDULER_IDS,
} from './recurring-schedule-registry';

// Makes `RECURRING_SCHEDULES` the authority over what actually repeats.
//
// Two halves, and the second is the one that matters:
//   - UPSERT every declared schedule. Idempotent by scheduler ID, so every
//     instance in a scaled deployment converges on one definition rather than N.
//   - REMOVE every scheduler on a registered queue that the registry does not
//     declare. Without this, deleting a recurring job from the code leaves its
//     scheduler running in Redis forever, producing jobs whose name no deployed
//     release recognises — each one failing permanently, on a schedule, with no
//     code left anywhere that explains where they come from.
//
// Deployment note: reconciliation makes the RUNNING release authoritative. Prod
// and staging stop the old container before starting the new one, so there is
// no overlap. If instances of two releases ever run concurrently, they will
// briefly disagree about a schedule added or removed between them — converging
// once the deploy completes, and the transient jobs fail safely as unknown job
// names rather than doing anything.
//
// Nothing here is awaited by boot. The queue connection uses
// `maxRetriesPerRequest: null`, so a command issued against an unreachable
// Redis is buffered forever rather than rejected — awaiting would mean the HTTP
// server never starts during a Redis outage instead of starting without its
// schedules.
@Injectable()
export class RecurringScheduleInstaller
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RecurringScheduleInstaller.name);
  // An in-flight install rejects with "Connection is closed" when the app shuts
  // down first. That is an orderly shutdown, not a failure worth reporting.
  private isShuttingDown = false;

  constructor(private readonly queueProducer: QueueProducerService) {}

  onModuleDestroy(): void {
    this.isShuttingDown = true;
  }

  onApplicationBootstrap(): void {
    this.installDeclaredSchedules().catch((error: unknown) => {
      if (this.isShuttingDown) {
        return;
      }
      this.logger.error(
        `Could not install recurring schedules: ${formatErrorMessage(error)}`,
      );
    });
  }

  private async installDeclaredSchedules(): Promise<void> {
    for (const registration of RECURRING_SCHEDULES) {
      await this.queueProducer.upsertRecurringSchedule(
        registration.jobName,
        registration.buildPayload(),
        registration.schedule,
      );
    }

    await this.removeUndeclaredSchedules();
  }

  private async removeUndeclaredSchedules(): Promise<void> {
    for (const queueName of REGISTERED_QUEUE_NAMES) {
      const installedSchedulerIds =
        await this.queueProducer.listRecurringScheduleIds(queueName);

      for (const schedulerId of installedSchedulerIds) {
        if (REGISTERED_SCHEDULER_IDS.has(schedulerId)) {
          continue;
        }
        this.logger.warn(
          `Removing orphaned recurring schedule "${schedulerId}" from queue "${queueName}" — it is no longer declared in RECURRING_SCHEDULES`,
        );
        await this.queueProducer.removeRecurringSchedule(
          queueName,
          schedulerId,
        );
      }
    }
  }

  // Exposed for the e2e spec, which needs to drive reconciliation
  // deterministically rather than racing the bootstrap hook.
  async reconcileNow(): Promise<void> {
    await this.installDeclaredSchedules();
  }
}
