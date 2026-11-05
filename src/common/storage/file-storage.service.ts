import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { withTimeout } from '../util/promise-timeout.util';
import { resolveSignedUrlTtlSeconds } from '../util/signed-url-ttl.util';
import { buildObjectName } from '../util/storage-object-name.util';
import {
  FILE_STORAGE_ADAPTER,
  ObjectContent,
} from './adapters/file-storage-adapter.interface';
import type { FileStorageAdapter } from './adapters/file-storage-adapter.interface';

// The storage capability the rest of the application depends on. Adapter
// selection (stub / s3 / gcs / azure) happens in FileStorageModule's provider
// factory, so no call site knows or can discover which backend is active — and
// no provider SDK is reachable from domain code.
//
// The flow when persisting a file (`src/modules/files` is the one caller):
//   1. `createKey('files/documents', '.pdf')` → a server-minted key.
//   2. write **that key** into the database row FIRST — not a URL. A URL embeds
//      the bucket, the provider and the access model; a key survives all three
//      changing. Recording it before the write means no object can exist that
//      no row knows about, so cleanup never has to list the bucket.
//   3. `put(key, content)`.
//   4. to serve it later: authorize the caller, THEN `createSignedReadUrl`.
//   5. to remove it: `delete(key)`, which throws on any failure other than
//      "already gone" so the caller can keep the row and retry.
//
// `subdirectory` is a CODE-CHOSEN CONSTANT, never request input.
// `buildObjectName` refuses anything that could reshape the stored path and
// always mints the identifying half as a fresh UUID.
export interface SignedReadUrl {
  url: string;
  expiresAt: Date;
}

@Injectable()
export class FileStorageService {
  private readonly defaultSignedUrlTtlSeconds: number;
  private readonly requestTimeoutMs: number;

  constructor(
    @Inject(FILE_STORAGE_ADAPTER) private readonly adapter: FileStorageAdapter,
    configService: ConfigService,
  ) {
    this.defaultSignedUrlTtlSeconds = configService.getOrThrow<number>(
      'storage.signedUrlTtlSeconds',
    );
    this.requestTimeoutMs = configService.getOrThrow<number>(
      'storage.requestTimeoutMs',
    );
  }

  // Which backend is active. For logs and diagnostics — never branch on it;
  // anything that would belongs behind the adapter interface.
  get providerName(): string {
    return this.adapter.providerName;
  }

  createKey(subdirectory: string, fileExtension: string): string {
    return buildObjectName(subdirectory, fileExtension);
  }

  put(storageKey: string, content: ObjectContent): Promise<void> {
    return this.adapter.put(storageKey, content);
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
   * site cannot mint a long-lived one by passing a large number. `expiresAt`
   * tells the client when to ask again.
   *
   * Bounded by `storage.requestTimeoutMs`, like every other storage call: on
   * GCS a signature is a remote IAM `signBlob` request that the SDK sends with
   * no timeout of its own, and a slow (not dead) IAM must cost a missing
   * picture, not a hung page.
   */
  async createSignedReadUrl(
    storageKey: string,
    ttlSeconds?: number,
  ): Promise<SignedReadUrl> {
    const effectiveTtlSeconds = resolveSignedUrlTtlSeconds(
      ttlSeconds,
      this.defaultSignedUrlTtlSeconds,
    );
    // Stamped BEFORE signing, so the reported expiry is never later than the
    // signature's own — a client refreshing at `expiresAt` is never late.
    const expiresAt = new Date(Date.now() + effectiveTtlSeconds * 1000);
    const url = await withTimeout(
      this.adapter.createSignedReadUrl(storageKey, effectiveTtlSeconds),
      this.requestTimeoutMs,
      `Signing a read URL timed out after ${this.requestTimeoutMs} ms`,
    );
    return { url, expiresAt };
  }
}
