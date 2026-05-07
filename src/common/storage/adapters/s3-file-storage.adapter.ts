import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import * as path from 'path';
import {
  FileStorageAdapter,
  SavedFile,
} from './file-storage-adapter.interface';

// AWS S3 (or S3-compatible: Cloudflare R2, MinIO, DigitalOcean Spaces) adapter.
// Selected when STORAGE_PROVIDER=s3.
//
// Auth: standard AWS credential chain — env vars (`AWS_ACCESS_KEY_ID` +
// `AWS_SECRET_ACCESS_KEY`), shared config files, or instance/task IAM
// roles when running on AWS-hosted compute. The SDK figures it out; this
// class just passes `region` (and optionally `endpoint` for R2 / MinIO /
// Spaces).
//
// Bucket access: for the public URLs we return to be directly fetchable,
// either (a) make the bucket public-read, or (b) set
// `STORAGE_S3_PUBLIC_URL_BASE` to a CloudFront / R2 / Cloudflare-CDN
// hostname that fronts the bucket. We don't return signed URLs by design —
// caller code embeds these URLs into DB rows; signed URLs would expire.
//
// `storageKey` is the S3 object key (e.g. "<uuid>.png").
// `url` defaults to `https://<bucket>.s3.<region>.amazonaws.com/<key>`,
// or `STORAGE_S3_PUBLIC_URL_BASE/<key>` when set.
@Injectable()
export class S3FileStorageAdapter implements FileStorageAdapter {
  private readonly logger = new Logger(S3FileStorageAdapter.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrlBase: string;

  constructor(configService: ConfigService) {
    this.bucket = configService.getOrThrow<string>('storage.s3.bucket');
    const region = configService.getOrThrow<string>('storage.s3.region');
    const endpoint = configService.get<string>('storage.s3.endpoint');
    const forcePathStyle =
      configService.get<boolean>('storage.s3.forcePathStyle') ?? false;
    this.publicUrlBase = (
      configService.get<string>('storage.s3.publicUrlBase') ??
      `https://${this.bucket}.s3.${region}.amazonaws.com`
    ).replace(/\/+$/, '');
    this.client = new S3Client({
      region,
      // `endpoint` is the escape hatch for S3-compatible providers
      // (Cloudflare R2: `https://<account-id>.r2.cloudflarestorage.com`;
      // DigitalOcean Spaces: `https://<region>.digitaloceanspaces.com`;
      // MinIO: `http://localhost:9000`). Leave unset for real AWS.
      ...(endpoint ? { endpoint } : {}),
      // Path-style addressing (`https://endpoint/bucket/key`) instead of
      // virtual-host style (`https://bucket.endpoint/key`). Required by
      // some S3-compatible servers (older MinIO, some self-hosted setups).
      forcePathStyle,
    });
  }

  async save(file: Express.Multer.File, subdir: string): Promise<SavedFile> {
    const ext = path.extname(file.originalname).toLowerCase();
    // `subdir = ''` is supported and means "save flat at the bucket
    // root". Without this guard the object key would have a leading `/`
    // which S3 treats as part of the literal key — `bucket//uuid.png` is
    // technically valid but breaks the public URL.
    const cleanSubdir = subdir.replace(/^\/+|\/+$/g, '');
    const key = cleanSubdir
      ? `${cleanSubdir}/${randomUUID()}${ext}`
      : `${randomUUID()}${ext}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        // Cache aggressively at the CDN — uploaded objects are
        // immutable (UUID-named, never overwritten). 1 year + immutable
        // hint lets any fronting CDN keep them indefinitely.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return {
      storageKey: key,
      url: `${this.publicUrlBase}/${key}`,
    };
  }

  async delete(storageKey: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }),
      );
    } catch (err) {
      this.logger.warn(
        `Failed to delete s3://${this.bucket}/${storageKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async deleteByUrl(url: string): Promise<void> {
    if (!url.startsWith(`${this.publicUrlBase}/`)) return;
    const key = url.slice(this.publicUrlBase.length + 1);
    if (key.length === 0) return;
    await this.delete(key);
  }
}
