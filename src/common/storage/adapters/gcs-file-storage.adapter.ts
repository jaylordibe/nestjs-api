import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Storage } from '@google-cloud/storage';
import * as path from 'path';
import { formatErrorMessage } from '../../util/error-message.util';
import { buildObjectName } from '../../util/storage-object-name.util';
import {
  FileStorageAdapter,
  StoredObject,
} from './file-storage-adapter.interface';

// Google Cloud Storage. Selected with STORAGE_PROVIDER=gcs.
//
// This file is the ONLY place in the application that imports a Google SDK, and
// it is loaded only when this provider is selected.
//
// CREDENTIALS are Application Default Credentials — the runtime service account
// on Google-hosted compute, or a Workload Identity Federation configuration
// anywhere else. There is deliberately no configuration key for a
// service-account key file or an inline JSON key: a downloaded key is a
// long-lived credential that has to be stored, rotated and revoked, and every
// supported host has a keyless path.
//
// SIGNED URLS: with ADC there is no private key in the process, so the SDK
// signs through the IAM `signBlob` API. The runtime identity therefore needs
// `roles/iam.serviceAccountTokenCreator` **on itself** for
// `createSignedReadUrl` to work. Uploads and deletes need no such grant, so a
// deployment that never signs can skip it.
@Injectable()
export class GcsFileStorageAdapter implements FileStorageAdapter {
  readonly providerName = 'gcs';

  private readonly logger = new Logger(GcsFileStorageAdapter.name);
  private readonly storage: Storage;
  private readonly bucketName: string;
  private readonly publicUrlBase: string | null;

  constructor(configService: ConfigService) {
    this.bucketName = configService.getOrThrow<string>('storage.gcs.bucket');
    this.publicUrlBase =
      configService.get<string>('storage.publicUrlBase') ?? null;

    const projectId = configService.get<string>('storage.gcs.projectId');
    // `StorageOptions extends ServiceOptions`, which declares `timeout` — so
    // this provider is bounded exactly like S3 and Azure. Every remote call
    // needs a ceiling: the failure being guarded is a SLOW backend, not a dead
    // one, and an upload awaiting a hung request keeps its Postgres connection
    // checked out until it returns.
    const requestTimeoutMs = configService.getOrThrow<number>(
      'storage.requestTimeoutMs',
    );
    // Passed only when configured. Supplying it explicitly avoids resolving
    // whatever project the metadata server happens to report; omitting it lets
    // ADC decide, which is what a local `gcloud auth` session expects.
    this.storage = new Storage({
      timeout: requestTimeoutMs,
      ...(projectId ? { projectId } : {}),
    });
  }

  async save(
    file: Express.Multer.File,
    subdirectory: string,
  ): Promise<StoredObject> {
    const storageKey = buildObjectName(
      subdirectory,
      path.extname(file.originalname).toLowerCase(),
    );
    // resumable: false — a single-shot upload is faster for the bounded payload
    // sizes the upload configs accept; resumable adds a round trip that only
    // pays for itself on very large files.
    await this.storage
      .bucket(this.bucketName)
      .file(storageKey)
      .save(file.buffer, {
        contentType: file.mimetype,
        resumable: false,
        metadata: {
          // Immutable objects (fresh UUID per write, never overwritten), so a
          // fronting CDN can keep them indefinitely. This sets caching, not
          // permission — the bucket's own policy decides readability.
          cacheControl: 'public, max-age=31536000, immutable',
        },
      });
    return { storageKey, publicUrl: this.resolvePublicUrl(storageKey) };
  }

  async delete(storageKey: string): Promise<void> {
    try {
      await this.storage
        .bucket(this.bucketName)
        .file(storageKey)
        .delete({ ignoreNotFound: true });
    } catch (error) {
      this.logger.warn(
        `Failed to delete gs://${this.bucketName}/${storageKey}: ${formatErrorMessage(error)}`,
      );
    }
  }

  async createSignedReadUrl(
    storageKey: string,
    ttlSeconds: number,
  ): Promise<string> {
    const [signedUrl] = await this.storage
      .bucket(this.bucketName)
      .file(storageKey)
      .getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + ttlSeconds * 1000,
      });
    return signedUrl;
  }

  resolvePublicUrl(storageKey: string): string | null {
    return this.publicUrlBase ? `${this.publicUrlBase}/${storageKey}` : null;
  }
}
