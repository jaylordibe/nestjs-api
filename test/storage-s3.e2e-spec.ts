import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  CreateBucketCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { FileStorageModule } from '../src/common/storage/file-storage.module';
import { FileStorageService } from '../src/common/storage/file-storage.service';
import { PRIVATE_OBJECT_CACHE_CONTROL } from '../src/common/storage/adapters/file-storage-adapter.interface';

// The only test that drives a REAL object-storage backend.
//
// Every other storage test constructs an adapter and asserts which class came
// back, which proves the selection switch and nothing else — `put`, `delete`
// and `createSignedReadUrl` had never executed against anything. For an upload
// path that is the interesting half: a wrong option shape, an unsigned request,
// a key that does not round-trip, or a signed URL nobody can fetch all survive
// construction perfectly.
//
// It runs against the test compose stack's S3 server (RustFS), so it needs no cloud
// account and no cloud credential. The `s3` adapter is deliberately the one
// covered: it is also the AWS, Cloudflare R2, DigitalOcean Spaces, Ceph and
// self-hosted story, so this is the broadest single path available. The GCS and
// Azure adapters remain construction-only, which is stated in the deployment
// contract rather than left for someone to discover.
const BUCKET = process.env.STORAGE_S3_BUCKET ?? 'nestjs-e2e-uploads';
const ENDPOINT = process.env.STORAGE_S3_ENDPOINT ?? 'http://localhost:9002';
const REGION = process.env.STORAGE_S3_REGION ?? 'us-east-1';

const PNG_CONTENT_DISPOSITION = `inline; filename="photo.png"; filename*=UTF-8''photo.png`;

// Writes `contents` under a fresh key and returns that key — the order the
// files module uses: mint the key, record it, then write.
async function putObject(
  storage: FileStorageService,
  contents: string,
  contentType = 'image/png',
): Promise<string> {
  const storageKey = storage.createKey('files/test', '.png');
  await storage.put(storageKey, {
    body: Buffer.from(contents, 'utf8'),
    contentType,
    contentDisposition: PNG_CONTENT_DISPOSITION,
    cacheControl: PRIVATE_OBJECT_CACHE_CONTROL,
  });
  return storageKey;
}

// The real `FileStorageModule` over a hand-built ConfigService holding only the
// storage subtree, so the test needs no database, Redis or Joi schema.
async function buildStorage(
  overrides: Record<string, unknown> = {},
): Promise<FileStorageService> {
  const storageConfiguration: Record<string, unknown> = {
    'storage.provider': 's3',
    'storage.s3.bucket': BUCKET,
    'storage.s3.region': REGION,
    'storage.s3.endpoint': ENDPOINT,
    'storage.s3.isPathStyleForced': true,
    'storage.signedUrlTtlSeconds': 300,
    'storage.requestTimeoutMs': 15_000,
    ...overrides,
  };

  @Global()
  @Module({
    providers: [
      {
        provide: ConfigService,
        useValue: {
          get: (path: string) => storageConfiguration[path],
          getOrThrow: (path: string) => {
            const value = storageConfiguration[path];
            if (value === undefined) {
              throw new Error(`Missing configuration: ${path}`);
            }
            return value;
          },
        },
      },
    ],
    exports: [ConfigService],
  })
  class StorageConfigurationTestModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [StorageConfigurationTestModule, FileStorageModule],
  }).compile();

  return moduleRef.get(FileStorageService);
}

describe('S3 storage adapter against a real backend (e2e)', () => {
  let storage: FileStorageService;
  let inspectionClient: S3Client;

  beforeAll(async () => {
    inspectionClient = new S3Client({
      region: REGION,
      endpoint: ENDPOINT,
      forcePathStyle: true,
    });
    try {
      await inspectionClient.send(new CreateBucketCommand({ Bucket: BUCKET }));
    } catch {
      // Already there from a previous run. The suite owns this bucket.
    }

    storage = await buildStorage();
  });

  afterAll(() => {
    inspectionClient.destroy();
  });

  it('selects the s3 adapter', () => {
    expect(storage.providerName).toBe('s3');
  });

  it('writes an object with the server-chosen headers', async () => {
    const storageKey = await putObject(storage, 'hello-object');

    expect(storageKey).toMatch(/^files\/test\/[0-9a-f-]{36}\.png$/);

    // Asserted against the BACKEND, not against the return value — nothing
    // would look different if nothing had been written.
    const head = await inspectionClient.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: storageKey }),
    );
    expect(head.ContentLength).toBe(
      Buffer.from('hello-object', 'utf8').byteLength,
    );
    expect(head.ContentType).toBe('image/png');
    expect(head.ContentDisposition).toBe(PNG_CONTENT_DISPOSITION);
    // Private, and no longer-lived than the longest signed URL — a shared
    // cache must not keep serving it after the signature expires.
    expect(head.CacheControl).toBe(PRIVATE_OBJECT_CACHE_CONTROL);
  });

  // Objects are private by default; a signed URL is the supported read path.
  it('mints a signed URL that actually fetches the object', async () => {
    const storageKey = await putObject(storage, 'signed-url-body');

    const { url: signedUrl } = await storage.createSignedReadUrl(storageKey);
    const response = await fetch(signedUrl);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('signed-url-body');
    expect(response.headers.get('cache-control')).toBe(
      PRIVATE_OBJECT_CACHE_CONTROL,
    );
  });

  // The signature IS the permission. Without it the bucket must refuse.
  it('refuses an unsigned read of the same object', async () => {
    const storageKey = await putObject(storage, 'private-body');

    const unsignedUrl = `${ENDPOINT}/${BUCKET}/${storageKey}`;
    const response = await fetch(unsignedUrl);

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('deletes an object it stored', async () => {
    const storageKey = await putObject(storage, 'delete-me');

    await storage.delete(storageKey);

    await expect(
      inspectionClient.send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: storageKey }),
      ),
    ).rejects.toThrow();
  });

  // "Already gone" is success: the cleanup job deletes objects whose write may
  // never have completed.
  it('treats a delete of something that is not there as done', async () => {
    await expect(
      storage.delete('files/test/00000000-0000-4000-8000-000000000000.png'),
    ).resolves.toBeUndefined();
  });

  // Every other failure must surface, or the cleanup job would drop the row
  // of an object it never removed.
  it('propagates a delete failure instead of swallowing it', async () => {
    const unreachable = await buildStorage({
      'storage.s3.bucket': 'bucket-that-does-not-exist-e2e',
    });
    await expect(
      unreachable.delete('files/test/00000000-0000-4000-8000-000000000000.png'),
    ).rejects.toThrow();
  });

  // Two keys for the same subdirectory must not collide — the identifying half
  // of the name is server-minted, never caller-supplied.
  it('never mints the same key twice', () => {
    expect(storage.createKey('files/test', '.png')).not.toBe(
      storage.createKey('files/test', '.png'),
    );
  });
});
