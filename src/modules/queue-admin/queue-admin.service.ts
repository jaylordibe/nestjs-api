import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { AppAbility } from '../../common/authorization/app-ability';
import { Errors } from '../../common/errors/errors';
import { QueueInspectionService } from '../../common/queue/queue-inspection.service';
import type { QueueName } from '../../common/queue/queue-registry';
import {
  QueueJobResponseDto,
  QueueSummaryDto,
} from './dto/queue-job-response.dto';

/**
 * Authorization and audit around queue inspection.
 *
 * The queue mechanics live in `QueueInspectionService` (`common/queue`), which
 * knows nothing about who is asking. This layer owns the two things it must
 * not: whether the caller may see a job's raw payload, and recording the
 * recovery actions they take.
 *
 * `QueueJob` is the one authorization subject with no Prisma model behind it —
 * jobs live in Redis — so it is deliberately absent from
 * `AbilityScopedQueryService`'s subject map, and reaching for `accessibleBy` on
 * it is a compile error. There is no tenant to scope by either: a queue is
 * platform infrastructure and every permission on it is platform-scope ANY.
 */
@Injectable()
export class QueueAdminService {
  constructor(
    private readonly queueInspectionService: QueueInspectionService,
    private readonly auditService: AuditService,
  ) {}

  async summarize(): Promise<QueueSummaryDto[]> {
    const depths = await this.queueInspectionService.summarizeDepths();
    return depths.map((depth) => ({ ...depth }));
  }

  async findById(
    queueName: QueueName,
    jobId: string,
    ability: AppAbility,
  ): Promise<QueueJobResponseDto> {
    const job = await this.queueInspectionService.findJob(queueName, jobId);
    if (!job) {
      throw Errors.resourceNotFound('Queue job');
    }

    // Subject-TYPE check, which is both all that is available and all that is
    // needed: `readPayload QueueJob` is platform-scope ANY, so it carries no
    // condition for an instance check to evaluate.
    const mayReadPayload = ability.can('readPayload', 'QueueJob');

    return new QueueJobResponseDto({
      id: job.id,
      name: job.name,
      queue: job.queue,
      state: job.state,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      failedReason: job.failedReason,
      // Omitted entirely rather than masked. A `'[redacted]'` placeholder still
      // tells the reader a payload existed and how redaction is spelled, and
      // every masking scheme eventually leaks its own length or shape.
      ...(mayReadPayload ? { payload: job.payload } : {}),
    });
  }

  async retry(
    queueName: QueueName,
    jobId: string,
    actorId: string,
  ): Promise<void> {
    const { retried, state } = await this.queueInspectionService.retryFailedJob(
      queueName,
      jobId,
    );
    if (state === null) {
      throw Errors.resourceNotFound('Queue job');
    }
    if (!retried) {
      throw Errors.resourceConflict(
        `Only a failed job can be retried; this one is "${state}"`,
      );
    }

    await this.auditService.record({
      action: 'queue_job.retried',
      actorId,
      // No payload in the metadata: an audit row is read by more people than
      // this endpoint is, and the payload is precisely what `readPayload`
      // guards. Recording it here would route around that permission.
      metadata: { queue: queueName, jobId },
    });
  }

  async cancel(
    queueName: QueueName,
    jobId: string,
    actorId: string,
  ): Promise<void> {
    const { cancelled, state } = await this.queueInspectionService.cancelJob(
      queueName,
      jobId,
    );
    if (state === null) {
      throw Errors.resourceNotFound('Queue job');
    }
    if (!cancelled) {
      throw Errors.resourceConflict(
        'That job is currently running and cannot be cancelled',
      );
    }

    await this.auditService.record({
      action: 'queue_job.cancelled',
      actorId,
      metadata: { queue: queueName, jobId, state },
    });
  }
}
