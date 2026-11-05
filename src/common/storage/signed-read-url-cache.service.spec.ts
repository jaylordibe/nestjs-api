import type { RedisService } from '../redis/redis.service';
import type { FileStorageService } from './file-storage.service';
import {
  SIGNED_READ_URL_CACHE_PREFIX,
  SignedReadUrlCacheService,
} from './signed-read-url-cache.service';

describe('SignedReadUrlCacheService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  let store: Map<string, { value: string; ttl: number }>;
  let sign: jest.Mock;
  let service: SignedReadUrlCacheService;
  const now = new Date('2026-11-05T10:00:00.000Z');
  // A 300-second URL, as `FileStorageService` stamps it.
  const expiresAt = new Date(now.getTime() + 300_000);

  function build(redisClient: unknown): SignedReadUrlCacheService {
    const storage = {
      createSignedReadUrl: sign,
    } as unknown as FileStorageService;
    return new SignedReadUrlCacheService(storage, {
      client: redisClient,
    } as unknown as RedisService);
  }

  beforeEach(() => {
    jest.useFakeTimers({ now });
    store = new Map();
    sign = jest.fn((key: string) =>
      Promise.resolve({ url: `https://signed/${key}`, expiresAt }),
    );
    service = build({
      get: (key: string) => Promise.resolve(store.get(key)?.value ?? null),
      set: (key: string, value: string, _mode: string, ttl: number) => {
        store.set(key, { value, ttl });
        return Promise.resolve('OK');
      },
    });
  });

  it('signs a key once, then serves it from the cache with its real expiry', async () => {
    const first = await service.signedReadUrlFor('key-1');
    const second = await service.signedReadUrlFor('key-1');

    expect(sign).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ url: 'https://signed/key-1', expiresAt });
    expect(second).toEqual(first);
    expect(second.expiresAt).toBeInstanceOf(Date);
  });

  it('signs each distinct key', async () => {
    await service.signedReadUrlFor('key-1');
    await service.signedReadUrlFor('key-2');
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it('caches a URL for half its lifetime, so a served URL is never near expiry', async () => {
    await service.signedReadUrlFor('key-1');
    expect([...store.values()][0]?.ttl).toBe(150);
  });

  // The signature took long enough to use up some of the URL's life: the
  // entry lasts half of what is left, never past the half-validity promise.
  it('caches a slowly signed URL for half of what is left of its life', async () => {
    sign.mockImplementationOnce((key: string) => {
      jest.setSystemTime(new Date(now.getTime() + 200_000));
      return Promise.resolve({ url: `https://signed/${key}`, expiresAt });
    });
    await service.signedReadUrlFor('key-1');
    expect([...store.values()][0]?.ttl).toBe(50);
  });

  it('caches nothing when a URL has almost no life left once signed', async () => {
    sign.mockImplementationOnce((key: string) => {
      jest.setSystemTime(new Date(expiresAt.getTime() - 1_000));
      return Promise.resolve({ url: `https://signed/${key}`, expiresAt });
    });
    const result = await service.signedReadUrlFor('key-1');
    expect(result.url).toBe('https://signed/key-1');
    expect(store.size).toBe(0);
  });

  it('signs again when the cached entry cannot be read', async () => {
    store.set(`${SIGNED_READ_URL_CACHE_PREFIX}key-1`, {
      value: 'not json',
      ttl: 150,
    });
    const result = await service.signedReadUrlFor('key-1');
    expect(result.url).toBe('https://signed/key-1');
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('still signs when Redis is down', async () => {
    const offline = build({
      get: () => Promise.reject(new Error('redis down')),
      set: () => Promise.reject(new Error('redis down')),
    });
    const result = await offline.signedReadUrlFor('key-1');
    expect(result.url).toBe('https://signed/key-1');
  });

  // The caller decides what a failed signature costs; nothing is cached.
  it('passes a signing failure to the caller and caches nothing', async () => {
    sign.mockRejectedValueOnce(new Error('signBlob denied'));
    await expect(service.signedReadUrlFor('key-1')).rejects.toThrow(
      'signBlob denied',
    );
    expect(store.size).toBe(0);
  });
});
