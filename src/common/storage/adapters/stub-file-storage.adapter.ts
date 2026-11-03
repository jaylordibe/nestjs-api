import { Injectable, Logger } from '@nestjs/common';
import {
  FileStorageAdapter,
  ObjectContent,
} from './file-storage-adapter.interface';

// Used when STORAGE_PROVIDER=stub — the default, and what local development
// and the entire e2e suite run against. Buffers are dropped; nothing is
// persisted. The point is that the upload FLOW is exercisable with no cloud
// account, no credential, and no network.
//
// Signed URLs are shaped `stub://<subdir>/<uuid>.<ext>?…` so caller code that
// stores a key or requests a signed URL behaves identically here and against a
// real backend.
@Injectable()
export class StubFileStorageAdapter implements FileStorageAdapter {
  readonly providerName = 'stub';

  private static readonly URL_PREFIX = 'stub://';
  private readonly logger = new Logger(StubFileStorageAdapter.name);

  put(storageKey: string, content: ObjectContent): Promise<void> {
    this.logger.log(
      `[storage:stub] stored key=${storageKey} size=${content.body.byteLength} type=${content.contentType}`,
    );
    return Promise.resolve();
  }

  delete(storageKey: string): Promise<void> {
    this.logger.log(`[storage:stub] deleted key=${storageKey}`);
    return Promise.resolve();
  }

  // Shaped like a real signed URL — opaque signature, explicit expiry — so a
  // caller cannot accidentally depend on the stub returning something
  // permanently valid. It grants access to nothing, because nothing was stored.
  createSignedReadUrl(storageKey: string, ttlSeconds: number): Promise<string> {
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + ttlSeconds;
    return Promise.resolve(
      `${StubFileStorageAdapter.URL_PREFIX}${storageKey}?signature=stub&expires=${expiresAtSeconds}`,
    );
  }
}
