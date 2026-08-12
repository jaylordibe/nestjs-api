import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
// ONLY THE WORKER RUNTIME INSTALLS SCHEDULES. Gated on QUEUE_WORKER_ENABLED,
// which is the same flag that decides whether this process consumes jobs:
//
//   API runtime      QUEUE_WORKER_ENABLED=false → produces, never consumes,
//                    never reconciles
//   Worker runtime   QUEUE_WORKER_ENABLED=true  → consumes and reconciles
//
// The gate is not cosmetic. Reconciliation REMOVES schedulers the running
// release does not declare, so an API instance running a different release from
// the workers would fight them for the contents of Redis. Confining the write
// to the runtime that also owns the consumers means one release, one authority.
// Upsert is idempotent by scheduler ID, so N concurrent worker instances
// converge on one definition rather than N.
//
// Deployment note: reconciliation makes the RUNNING release authoritative. If
// instances of two releases ever run concurrently, they will briefly disagree
// about a schedule added or removed between them — converging once the deploy
// completes, and the transient jobs fail safely as unknown job names rather
// than doing anything.
//
// Nothing here is awaited by boot. The queue connection uses
// `maxRetriesPerRequest: null`, so a command issued against an unreachable
// Redis is buffered forever rather than rejected — awaiting would mean the
// worker never finishes starting during a Redis outage instead of starting and
// converging when Redis returns.
//
// A failure that survives all of that is observable without extra machinery:
// the queue heartbeat is itself one of these schedules, so an installation that
// never lands stops the heartbeat, and `GET /api/health/workers` goes stale
// within three intervals. That endpoint is the alarm; this class does not need
// a retry loop of its own.
@Injectable()
export class RecurringScheduleInstaller
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RecurringScheduleInstaller.name);
  // An in-flight install rejects with "Connection is closed" when the app shuts
  // down first. That is an orderly shutdown, not a failure worth reporting.
  private isShuttingDown = false;

  constructor(
    private readonly queueProducer: QueueProducerService,
    private readonly configService: ConfigService,
  ) {}

  onModuleDestroy(): void {
    this.isShuttingDown = true;
  }

  onApplicationBootstrap(): void {
    if (!this.configService.getOrThrow<boolean>('queue.workerEnabled')) {
      this.logger.log(
        'Worker disabled by configuration — this process enqueues jobs but does not install or reconcile recurring schedules. The worker runtime owns them.',
      );
      return;
    }

    this.installDeclaredSchedules().catch((error: unknown) => {
      if (this.isShuttingDown) {
        return;
      }
      this.logger.error(
        `Could not install recurring schedules: ${formatErrorMessage(error)}. Recurring jobs — including the queue heartbeat behind GET /api/health/workers — are NOT running in this process.`,
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
