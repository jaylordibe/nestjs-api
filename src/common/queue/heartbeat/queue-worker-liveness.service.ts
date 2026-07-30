import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import {
  QUEUE_HEARTBEAT_STALE_AFTER_MILLISECONDS,
  buildQueueHeartbeatRedisKey,
} from './queue-heartbeat.constants';

export interface QueueWorkerHeartbeat {
  // Null when no worker has ever beaten, the key has expired, or its value is
  // unreadable — three causes with one operational meaning.
  readonly observedAt: Date | null;
  readonly isFresh: boolean;
  readonly staleAfterMilliseconds: number;
}

// Answers "is anything consuming the queues?" by reading the heartbeat the one
// shipped job writes.
//
// Lives HERE, in `heartbeat/`, rather than on the generic `QueueStatusService`:
// the key format and the freshness rule are properties of the heartbeat job,
// and the generic layer should not know them. That keeps `heartbeat/` the only
// place in this module that knows a specific job exists — which is what makes
// "the shared infrastructure contains no domain logic" checkable by looking at
// the folder rather than by trusting a comment.
@Injectable()
export class QueueWorkerLivenessService {
  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {}

  async readHeartbeat(): Promise<QueueWorkerHeartbeat> {
    const serviceName = this.configService.getOrThrow<string>('serviceName');
    const rawHeartbeat = await this.redisService.client.get(
      buildQueueHeartbeatRedisKey(serviceName),
    );

    const parsedHeartbeat = rawHeartbeat ? new Date(rawHeartbeat) : null;
    const observedAt =
      parsedHeartbeat && !Number.isNaN(parsedHeartbeat.getTime())
        ? parsedHeartbeat
        : null;

    return {
      observedAt,
      isFresh:
        observedAt !== null &&
        Date.now() - observedAt.getTime() <=
          QUEUE_HEARTBEAT_STALE_AFTER_MILLISECONDS,
      staleAfterMilliseconds: QUEUE_HEARTBEAT_STALE_AFTER_MILLISECONDS,
    };
  }
}
