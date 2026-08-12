import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import { buildObjectName } from '../../util/storage-object-name.util';
import {
  FileStorageAdapter,
  StoredObject,
} from './file-storage-adapter.interface';

// Used when STORAGE_PROVIDER=stub — the default, and what local development
// and the entire e2e suite run against. Buffers are dropped; nothing is
// persisted. The point is that the upload FLOW is exercisable with no cloud
// account, no credential, and no network.
//
// URLs are shaped `stub://<subdir>/<uuid>.<ext>` so caller code that stores a
// key, builds a URL, or requests a signed URL behaves identically here and
// against a real backend.
@Injectable()
export class StubFileStorageAdapter implements FileStorageAdapter {
  readonly providerName = 'stub';

  private static readonly URL_PREFIX = 'stub://';
  private readonly logger = new Logger(StubFileStorageAdapter.name);

  save(file: Express.Multer.File, subdirectory: string): Promise<StoredObject> {
    // Shared with every real adapter, deliberately: the stub is what the tests
    // exercise, so a subdirectory the real adapters would refuse must be
    // refused here too — otherwise the rule is only enforced in the one
    // environment nobody tests against.
    const storageKey = buildObjectName(
      subdirectory,
      path.extname(file.originalname).toLowerCase(),
    );
    this.logger.log(
      `[storage:stub] saved key=${storageKey} size=${file.size} mime=${file.mimetype}`,
    );
    return Promise.resolve({
      storageKey,
      publicUrl: this.resolvePublicUrl(storageKey),
    });
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

  resolvePublicUrl(storageKey: string): string {
    return `${StubFileStorageAdapter.URL_PREFIX}${storageKey}`;
  }
}
