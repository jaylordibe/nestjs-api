import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolveSignedUrlTtlSeconds } from '../util/signed-url-ttl.util';
import {
  FILE_STORAGE_ADAPTER,
  StoredObject,
} from './adapters/file-storage-adapter.interface';
import type { FileStorageAdapter } from './adapters/file-storage-adapter.interface';

// The storage capability the rest of the application depends on. Adapter
// selection (stub / s3 / gcs / azure) happens in FileStorageModule's provider
// factory, so no call site knows or can discover which backend is active — and
// no provider SDK is reachable from domain code.
//
// Typical flow when persisting a user upload:
//   1. `save(file, 'avatars')` → `{ storageKey, publicUrl }`
//   2. write **`storageKey`** into the database row — not the URL. A URL embeds
//      the bucket, the provider and the access model; a key survives all three
//      changing.
//   3. on DB failure, `delete(storageKey)` to roll back.
//   4. to serve it later: authorize the caller, THEN `createSignedReadUrl`.
//
// `subdirectory` is a CODE-CHOSEN CONSTANT, never request input. The adapters
// build the object name themselves (`buildObjectName`), which refuses anything
// that could reshape the stored path and always mints the identifying half as a
// fresh UUID.
@Injectable()
export class FileStorageService {
  private readonly defaultSignedUrlTtlSeconds: number;

  constructor(
    @Inject(FILE_STORAGE_ADAPTER) private readonly adapter: FileStorageAdapter,
    configService: ConfigService,
  ) {
    this.defaultSignedUrlTtlSeconds = configService.getOrThrow<number>(
      'storage.signedUrlTtlSeconds',
    );
  }

  // Which backend is active. For logs and diagnostics — never branch on it;
  // anything that would belongs behind the adapter interface.
  get providerName(): string {
    return this.adapter.providerName;
  }

  save(file: Express.Multer.File, subdirectory: string): Promise<StoredObject> {
    return this.adapter.save(file, subdirectory);
  }

  delete(storageKey: string): Promise<void> {
    return this.adapter.delete(storageKey);
  }

  /**
   * A short-lived, read-only URL for one stored object.
   *
   * **AUTHORIZE FIRST.** The returned string is a bearer credential: anyone
   * holding it can read the object until it expires, with no further check, and
   * it cannot be revoked. This method has no idea who is asking and performs no
   * authorization of its own — the caller must already have established that
   * this principal may read this object (see `AbilityScopedQueryService`, and
   * the 404-versus-403 rule in `src/common/authorization/README.md`).
   *
   * The lifetime is clamped centrally (`resolveSignedUrlTtlSeconds`), so a call
   * site cannot mint a long-lived one by passing a large number.
   */
  createSignedReadUrl(
    storageKey: string,
    ttlSeconds?: number,
  ): Promise<string> {
    return this.adapter.createSignedReadUrl(
      storageKey,
      resolveSignedUrlTtlSeconds(ttlSeconds, this.defaultSignedUrlTtlSeconds),
    );
  }

  /**
   * The directly-fetchable URL for a key, or **null when the deployment has not
   * declared its objects public**.
   *
   * Null is the default. A non-null result means an operator set
   * `STORAGE_PUBLIC_URL_BASE`, which is an explicit assertion that this bucket
   * is world-readable or CDN-fronted. Nothing here makes a bucket public and
   * nothing assumes one is; for private storage, use `createSignedReadUrl`.
   */
  resolvePublicUrl(storageKey: string): string | null {
    return this.adapter.resolvePublicUrl(storageKey);
  }
}
