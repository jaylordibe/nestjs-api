import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { formatErrorMessage } from '../util/error-message.util';
import { FileStorageService, type SignedReadUrl } from './file-storage.service';

/** Where the cached URLs live in Redis; exported for tests that empty it. */
export const SIGNED_READ_URL_CACHE_PREFIX = 'storage:signed-read-url:v1:';

/**
 * Signed read URLs, cached — for files shown on pages that are read often
 * (people's pictures in a list, a gallery's photos).
 *
 * Signing is not free on every backend — GCS signs through the IAM `signBlob`
 * API, Azure fetches a delegation key — and a page of 100 rows would sign 100
 * URLs on every view. Each URL is therefore cached in Redis for HALF its
 * lifetime: a cached URL always has at least half its validity left when
 * served, repeat views cost no signing calls, and a stable URL lets browsers
 * and CDNs cache the bytes. The expiry is cached with it, so `expiresAt` is
 * the URL's own.
 *
 * **Callers establish access first**: this answers for any key it is given,
 * exactly like `FileStorageService.createSignedReadUrl`. Removing a file stops
 * the API returning its URL at once — callers look up which files are current
 * before asking for a URL — and a URL already handed out stays valid until it
 * expires, cached or not.
 *
 * A signing failure is thrown to the caller, which decides what it costs;
 * Redis is an optimisation only, and an outage falls through to signing.
 */
@Injectable()
export class SignedReadUrlCacheService {
  private readonly logger = new Logger(SignedReadUrlCacheService.name);

  constructor(
    private readonly fileStorageService: FileStorageService,
    private readonly redis: RedisService,
  ) {}

  /** The signed read URL for one stored object, from the cache when it holds one. */
  async signedReadUrlFor(storageKey: string): Promise<SignedReadUrl> {
    const cacheKey = `${SIGNED_READ_URL_CACHE_PREFIX}${storageKey}`;
    const cached = await this.redis.client
      .get(cacheKey)
      .catch((error: unknown) => {
        this.logger.warn(`Redis read failed: ${formatErrorMessage(error)}`);
        return null;
      });
    const fromCache = cached ? parseCached(cached) : null;
    if (fromCache) return fromCache;

    const signed =
      await this.fileStorageService.createSignedReadUrl(storageKey);
    // Half of what is LEFT of the URL's life once signed, not half its full
    // lifetime: a slow signature must not leave an entry that outlives the
    // half-validity promise, or serves a URL already expired.
    const cacheTtlSeconds = Math.floor(
      (signed.expiresAt.getTime() - Date.now()) / 2000,
    );
    if (cacheTtlSeconds > 0) {
      await this.redis.client
        .set(
          cacheKey,
          JSON.stringify({
            url: signed.url,
            expiresAt: signed.expiresAt.toISOString(),
          }),
          'EX',
          cacheTtlSeconds,
        )
        .catch((error: unknown) => {
          this.logger.warn(`Redis write failed: ${formatErrorMessage(error)}`);
        });
    }
    return signed;
  }
}

// An entry this version did not write (or a corrupted one) is a miss.
function parseCached(value: string): SignedReadUrl | null {
  try {
    const parsed = JSON.parse(value) as { url?: unknown; expiresAt?: unknown };
    if (
      typeof parsed.url !== 'string' ||
      typeof parsed.expiresAt !== 'string'
    ) {
      return null;
    }
    const expiresAt = new Date(parsed.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) return null;
    return { url: parsed.url, expiresAt };
  } catch {
    return null;
  }
}
