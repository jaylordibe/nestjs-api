import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import { QueueHeartbeatPayloadDto } from './queue-heartbeat-payload.dto';
import { JobName } from '../job-registry';
import {
  RegisterQueueJobHandler,
  type QueueJobHandler,
} from '../queue-job-handler';
import {
  completedJob,
  skippedJob,
  type JobOutcome,
} from '../queue-job-outcome';
import {
  QUEUE_HEARTBEAT_INTERVAL_MILLISECONDS,
  QUEUE_HEARTBEAT_KEY_TTL_SECONDS,
  buildQueueHeartbeatRedisKey,
} from './queue-heartbeat.constants';

// The reference handler — this is the whole shape a domain handler copies.
//
// Its side effect is deliberately trivial (stamp a key) because it is
// infrastructure, not a feature: it must never acquire domain behaviour of any
// kind. A real handler differs only in what `handle` does, and in reloading its
// domain row and checking business idempotence before acting.
@Injectable()
@RegisterQueueJobHandler()
export class QueueHeartbeatHandler implements QueueJobHandler<QueueHeartbeatPayloadDto> {
  readonly jobName = JobName.MAINTENANCE_QUEUE_HEARTBEAT_V1;
  readonly payloadType = QueueHeartbeatPayloadDto;

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {}

  async handle(payload: QueueHeartbeatPayloadDto): Promise<JobOutcome> {
    // The stale-schedule check every domain handler owes its own version of.
    // Here the rule is simple because the domain is trivial: a heartbeat that
    // has sat in the queue longer than one interval has already been superseded
    // by a newer one, so running it proves nothing about right now. It is
    // SKIPPED, not failed — nothing went wrong, the job just stopped being
    // worth doing, and retrying it would only make it staler.
    if (payload.scheduledAt) {
      const scheduledAtMilliseconds = new Date(payload.scheduledAt).getTime();
      const latenessMilliseconds = Date.now() - scheduledAtMilliseconds;
      if (latenessMilliseconds > QUEUE_HEARTBEAT_INTERVAL_MILLISECONDS) {
        return skippedJob(
          `superseded — scheduled ${latenessMilliseconds}ms ago, longer than one heartbeat interval`,
        );
      }
    }

    const serviceName = this.configService.getOrThrow<string>('serviceName');
    await this.redisService.client.set(
      buildQueueHeartbeatRedisKey(serviceName),
      new Date().toISOString(),
      'EX',
      QUEUE_HEARTBEAT_KEY_TTL_SECONDS,
    );
    return completedJob();
  }
}
