import type { ConfigService } from '@nestjs/config';
import type { FileStorageAdapter } from './adapters/file-storage-adapter.interface';
import { FileStorageService } from './file-storage.service';

describe('FileStorageService.createSignedReadUrl', () => {
  function build(adapter: Partial<FileStorageAdapter>): FileStorageService {
    const values: Record<string, number> = {
      'storage.signedUrlTtlSeconds': 300,
      'storage.requestTimeoutMs': 50,
    };
    const config = {
      getOrThrow: (path: string) => values[path],
    } as unknown as ConfigService;
    return new FileStorageService(adapter as FileStorageAdapter, config);
  }

  it('returns the URL and when it expires', async () => {
    const service = build({
      createSignedReadUrl: (key: string) =>
        Promise.resolve(`https://signed/${key}`),
    });
    const before = Date.now();
    const { url, expiresAt } = await service.createSignedReadUrl('key-1');
    expect(url).toBe('https://signed/key-1');
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 300_000);
  });

  // A slow backend (on GCS, the IAM signBlob call) must fail within the
  // storage request timeout, so a caller can leave the picture out instead
  // of waiting on it.
  it('gives up on a signature that does not come back within the request timeout', async () => {
    const service = build({
      createSignedReadUrl: () => new Promise<string>(() => undefined),
    });
    await expect(service.createSignedReadUrl('key-1')).rejects.toThrow(
      'Signing a read URL timed out after 50 ms',
    );
  });
});
