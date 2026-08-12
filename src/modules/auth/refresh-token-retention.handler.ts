import { Injectable, Logger } from '@nestjs/common';
import { JobName } from '../../common/queue/job-registry';
import {
  RegisterQueueJobHandler,
  type QueueJobHandler,
} from '../../common/queue/queue-job-handler';
import {
  completedJob,
  type JobOutcome,
} from '../../common/queue/queue-job-outcome';
import { RefreshTokenRetentionPayloadDto } from './dto/refresh-token-retention-payload.dto';
import { RefreshTokenService } from './refresh-token.service';

/**
 * Deletes refresh tokens that are past their expiry.
 *
 * Lives in the auth module rather than a shared jobs folder because it is
 * feature-owned — it sweeps a table this module alone writes to.
 *
 * Why bother, when an expired token already authorizes nothing: the row still
 * holds a user id, an IP address, and a user-agent string. That is a device
 * fingerprint per session, accumulating forever, serving no purpose once the
 * token is dead. Deleting it is data minimisation, not housekeeping.
 *
 * Revoked-but-unexpired rows are deliberately KEPT until their natural expiry.
 * They are what makes replay detectable — delete a consumed token early and a
 * replay of it reads as merely "unknown", which silently downgrades a theft
 * signal into a shrug.
 *
 * Runs as a RECURRING BULLMQ JOB, declared in
 * `common/queue/recurring-schedule-registry.ts`, not as an in-process cron. The
 * distinction is operational, not stylistic: an in-process scheduler fires once
 * per instance, so a horizontally-scaled API would run this sweep N times a
 * night, and a restart during the scheduled minute would skip it entirely. A
 * BullMQ job scheduler lives in Redis, produces exactly one job per tick no
 * matter how many workers are running, and survives the replacement of every
 * process that ever touched it.
 *
 * IDEMPOTENT by construction: the delete is bounded by `expiresAt < now`, so a
 * duplicate delivery finds nothing left and a missed tick is absorbed by the
 * next one. Nothing here is irreversible in the sense that matters — no message
 * leaves the system, no money moves.
 */
@Injectable()
@RegisterQueueJobHandler()
export class RefreshTokenRetentionHandler implements QueueJobHandler<RefreshTokenRetentionPayloadDto> {
  readonly jobName = JobName.AUTH_REFRESH_TOKEN_RETENTION_V1;
  readonly payloadType = RefreshTokenRetentionPayloadDto;

  private readonly logger = new Logger(RefreshTokenRetentionHandler.name);

  constructor(private readonly refreshTokenService: RefreshTokenService) {}

  async handle(): Promise<JobOutcome> {
    const deletedCount = await this.runOnce();
    return completedJob(
      deletedCount > 0
        ? `purged ${deletedCount} expired refresh token(s)`
        : undefined,
    );
  }

  // The testable seam: drivable directly from a spec or a runbook without going
  // near the queue. Idempotent — a second run finds nothing left.
  async runOnce(): Promise<number> {
    const deletedCount = await this.refreshTokenService.purgeExpired();
    if (deletedCount > 0) {
      this.logger.log(`Purged ${deletedCount} expired refresh token(s)`);
    }
    return deletedCount;
  }
}
