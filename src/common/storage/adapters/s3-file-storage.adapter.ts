import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import {
  FileStorageAdapter,
  ObjectContent,
} from './file-storage-adapter.interface';

// S3 and every S3-compatible backend: AWS S3, Cloudflare R2, DigitalOcean
// Spaces, Backblaze B2, MinIO, Ceph. Selected with STORAGE_PROVIDER=s3.
//
// This file is the ONLY place in the application that imports an AWS SDK, and
// it is loaded only when this provider is selected (`file-storage.module.ts`
// imports it dynamically). Nothing above the `FileStorageAdapter` interface
// knows S3 exists.
//
// CREDENTIALS come from the SDK's default provider chain, which is the keyless
// path on every host that offers one: an EC2 instance profile, an ECS task
// role, an EKS service account (IRSA), or a developer's local
// `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. This adapter never reads or
// accepts a credential of its own, so there is no configuration key here that
// could tempt a long-lived access key into the application's own config.
//
// R2 / MinIO / Spaces need `STORAGE_S3_ENDPOINT`, and some self-hosted servers
// additionally need `STORAGE_S3_FORCE_PATH_STYLE=true`.
@Injectable()
export class S3FileStorageAdapter implements FileStorageAdapter {
  readonly providerName = 's3';

  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(configService: ConfigService) {
    this.bucket = configService.getOrThrow<string>('storage.s3.bucket');

    const region = configService.get<string>('storage.s3.region');
    const endpoint = configService.get<string>('storage.s3.endpoint');
    const requestTimeoutMs = configService.getOrThrow<number>(
      'storage.requestTimeoutMs',
    );
    this.client = new S3Client({
      // Without an explicit handler the SDK applies NO request or connection
      // timeout, so a slow bucket holds the caller — and its database
      // connection — indefinitely.
      requestHandler: new NodeHttpHandler({
        requestTimeout: requestTimeoutMs,
        connectionTimeout: requestTimeoutMs,
      }),
      // Omitted rather than defaulted when unset, so the SDK's own resolution
      // (AWS_REGION, the instance metadata, the shared config file) still
      // applies. Passing a made-up default would override all of it.
      ...(region ? { region } : {}),
      ...(endpoint ? { endpoint } : {}),
      forcePathStyle:
        configService.get<boolean>('storage.s3.forcePathStyle') ?? false,
    });
  }

  async put(storageKey: string, content: ObjectContent): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        Body: content.body,
        ContentType: content.contentType,
        ContentDisposition: content.contentDisposition,
        // No ACL is ever set here, so the bucket's own policy decides
        // readability; this header only bounds caching of signed reads.
        CacheControl: content.cacheControl,
      }),
    );
  }

  // S3 answers a DeleteObject for a missing key with success, so "already
  // gone" needs no special case; anything else propagates for the caller to
  // retry.
  async delete(storageKey: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }),
    );
  }

  createSignedReadUrl(storageKey: string, ttlSeconds: number): Promise<string> {
    // SigV4 presigning is computed locally from the resolved credentials — no
    // network call, and no permission beyond the `s3:GetObject` the signer
    // already holds.
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }),
      { expiresIn: ttlSeconds },
    );
  }
}
