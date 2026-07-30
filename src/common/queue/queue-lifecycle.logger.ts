import { Injectable, Logger } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { JobName } from './job-registry';
import type { QueueName } from './queue-registry';

// Every lifecycle transition a job can go through. The producer emits the
// first, last two and `SCHEDULED`; the processor emits the rest.
export enum QueueLifecycleEvent {
  // A recurring Job Scheduler definition was created or updated.
  SCHEDULED = 'scheduled',
  ENQUEUED = 'enqueued',
  STARTED = 'started',
  COMPLETED = 'completed',
  RETRIED = 'retried',
  FAILED = 'failed',
  SKIPPED = 'skipped',
  CANCELLED = 'cancelled',
  RESCHEDULED = 'rescheduled',
}

// The ONLY fields a lifecycle line may carry.
//
// That this interface is a closed list is the point, not an inconvenience: it
// makes "never log a full job payload" a property of the type rather than a
// rule in a README. Payloads routinely carry recipient identifiers and, in
// domain jobs, the shape of somebody's booking — none of which belongs in a log
// aggregator. A handler that wants to explain itself does so through `reason`,
// which it writes deliberately.
export interface QueueLifecycleRecord {
  readonly event: QueueLifecycleEvent;
  readonly queueName: QueueName;
  readonly jobName: JobName | string;
  readonly jobId?: string;
  readonly payloadVersion?: number;
  readonly scheduleVersion?: number;
  readonly scheduledAt?: string;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly durationMilliseconds?: number;
  readonly reason?: string;
  readonly correlationId?: string;
}

type LifecycleLogLevel = 'debug' | 'info' | 'warn' | 'error';

// Exhaustive by type: adding a lifecycle event without deciding how loudly it
// should be reported is a compile error, not an event that silently defaults to
// info and drowns the log.
const LOG_LEVEL_BY_EVENT: Record<QueueLifecycleEvent, LifecycleLogLevel> = {
  [QueueLifecycleEvent.SCHEDULED]: 'info',
  [QueueLifecycleEvent.ENQUEUED]: 'info',
  // Every job logs one of these, and its only content is a repeat of what the
  // matching completed/failed line will say — useful when tracing a stuck job
  // in dev, pure volume in production.
  [QueueLifecycleEvent.STARTED]: 'debug',
  [QueueLifecycleEvent.COMPLETED]: 'info',
  [QueueLifecycleEvent.RETRIED]: 'warn',
  [QueueLifecycleEvent.FAILED]: 'error',
  [QueueLifecycleEvent.SKIPPED]: 'info',
  [QueueLifecycleEvent.CANCELLED]: 'info',
  [QueueLifecycleEvent.RESCHEDULED]: 'info',
};

// logfmt (`key=value`, quoted when the value has whitespace). Chosen over
// passing an object to the logger because every other log line in this codebase
// is a string, and pino wraps the whole line in its own JSON envelope in
// production anyway — so this stays greppable in dev, structured in prod, and
// consistent with the rest of the app.
function formatLifecycleRecord(record: QueueLifecycleRecord): string {
  const fields: [string, string | number | undefined][] = [
    ['event', record.event],
    ['queue', record.queueName],
    ['job', record.jobName],
    ['jobId', record.jobId],
    ['payloadVersion', record.payloadVersion],
    ['scheduleVersion', record.scheduleVersion],
    ['scheduledAt', record.scheduledAt],
    ['attempt', record.attempt],
    ['maxAttempts', record.maxAttempts],
    ['durationMs', record.durationMilliseconds],
    ['correlationId', record.correlationId],
    ['reason', record.reason],
  ];

  return fields
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => {
      const rendered = String(value);
      return /[\s"]/.test(rendered)
        ? `${key}="${rendered.replace(/"/g, "'")}"`
        : `${key}=${rendered}`;
    })
    .join(' ');
}

// Asked of pino directly, via its static root logger, because
// `Logger.isLevelEnabled` from @nestjs/common reads Nest's OWN static log
// levels — which nothing in this app configures — and would answer "yes" to
// debug while pino sits at info. That would make the guard below a lie.
//
// Fails OPEN. If the root logger is not there (a unit test that never
// bootstrapped LoggerModule), emit the line rather than silently swallow it:
// losing a failure log to an over-clever optimisation is far worse than
// formatting a string nobody reads.
function isLevelEnabled(level: LifecycleLogLevel): boolean {
  const rootLogger = PinoLogger.root as PinoLogger['logger'] | undefined;
  if (typeof rootLogger?.isLevelEnabled !== 'function') {
    return true;
  }
  return rootLogger.isLevelEnabled(level);
}

@Injectable()
export class QueueLifecycleLogger {
  private readonly logger = new Logger('QueueLifecycle');

  record(record: QueueLifecycleRecord): void {
    const level = LOG_LEVEL_BY_EVENT[record.event];
    // Checked BEFORE formatting. Every job emits a `started` line that is
    // discarded at production log levels, so building its string first would be
    // work done once per job purely to throw away — invisible on a queue doing
    // twelve jobs an hour, real on one doing thousands.
    if (!isLevelEnabled(level)) {
      return;
    }

    const line = formatLifecycleRecord(record);
    switch (level) {
      case 'error':
        this.logger.error(line);
        break;
      case 'warn':
        this.logger.warn(line);
        break;
      case 'debug':
        this.logger.debug(line);
        break;
      default:
        this.logger.log(line);
    }
  }
}
