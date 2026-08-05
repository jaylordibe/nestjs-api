import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { formatErrorMessage } from '../util/error-message.util';

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
    this.client.on('error', (error) => {
      this.logger.warn(`Redis error: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    // ioredis has seven statuses, and only two of them mean "there is nothing
    // to close": `wait` (lazyConnect, not yet dialled) and `end` (already
    // closed). Every other status — `connecting`, `connect`, `ready`, `close`,
    // `reconnecting` — holds either a live socket or an ARMED RECONNECT TIMER,
    // and both outlive the app if this returns early.
    //
    // `reconnecting` is the dangerous one: left alone, that client reconnects
    // AFTER the app is gone, then runs ioredis's post-connect handshake
    // (CLIENT SETNAME / SETINFO) against a socket nothing owns any more. The
    // handshake writes synchronously, so a dead socket surfaces as a bare
    // `write EPIPE` with no owner — which under Jest gets attributed to
    // whatever spec happens to be running, and is indistinguishable from a
    // flake: a different suite fails each run, with zero failing assertions,
    // and every suite passes in isolation.
    if (this.client.status === 'wait' || this.client.status === 'end') {
      return;
    }

    try {
      // QUIT is the graceful path: Redis finishes in-flight replies first.
      await this.client.quit();
    } catch (error) {
      // QUIT itself rejects when the connection drops before the command lands
      // ("Connection is closed"). A shutdown must not fail on that — force the
      // socket down, which also cancels the reconnect timer.
      this.logger.warn(
        `Redis QUIT failed during shutdown, forcing disconnect: ${formatErrorMessage(error)}`,
      );
      this.client.disconnect();
    }
  }
}
