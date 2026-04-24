import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

// Shared Redis client for app-level use (JWT revocation blocklist, etc.).
// The throttler maintains its own separate client via
// @nest-lab/throttler-storage-redis — both point at the same Redis instance
// but don't share the connection object. Acceptable: two connections per
// pod is negligible, and letting the throttler stay self-contained avoids
// the refactor.
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(config: ConfigService) {
    this.client = new Redis(config.getOrThrow<string>('redis.url'), {
      // Lazy connect so tests that never hit Redis don't trigger a
      // connection attempt at module load. The first actual command
      // triggers the connect.
      lazyConnect: true,
      // Don't retry forever on boot — fail fast so the bootstrap crashes
      // loudly if Redis is misconfigured.
      maxRetriesPerRequest: 3,
    });
    this.client.on('error', (err) => {
      this.logger.warn(`Redis error: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.status === 'ready' || this.client.status === 'connecting') {
      await this.client.quit();
    }
  }
}
