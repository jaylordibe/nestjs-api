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
import { PrismaService } from '../../prisma/prisma.service';
import { OAuthPayloadRetentionPayloadDto } from './dto/oauth-payload-retention-payload.dto';

/**
 * Deletes MCP OAuth records past their expiry: authorization codes, access
 * and refresh tokens, grants, sign-in interactions and browser sessions.
 * Registered clients have no expiry and are kept.
 *
 * An expired row already authorizes nothing (the adapter reads it as absent);
 * it still names a user and a client, so it goes. A recurring BullMQ job for
 * the same reasons as `RefreshTokenRetentionHandler`, and idempotent the same
 * way: the delete is bounded by `expires_at < now`.
 */
@Injectable()
@RegisterQueueJobHandler()
export class OAuthPayloadRetentionHandler implements QueueJobHandler<OAuthPayloadRetentionPayloadDto> {
  readonly jobName = JobName.MCP_OAUTH_PAYLOAD_RETENTION_V1;
  readonly payloadType = OAuthPayloadRetentionPayloadDto;

  private readonly logger = new Logger(OAuthPayloadRetentionHandler.name);

  constructor(private readonly prisma: PrismaService) {}

  async handle(): Promise<JobOutcome> {
    const deletedCount = await this.runOnce();
    return completedJob(
      deletedCount > 0
        ? `purged ${deletedCount} expired MCP OAuth record(s)`
        : undefined,
    );
  }

  async runOnce(): Promise<number> {
    const { count } = await this.prisma.oAuthPayload.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (count > 0) {
      this.logger.log(`Purged ${count} expired MCP OAuth record(s)`);
    }
    return count;
  }
}
