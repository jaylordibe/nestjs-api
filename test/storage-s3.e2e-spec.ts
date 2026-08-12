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

// The only test that drives a REAL object-storage backend.
//
// Every other storage test constructs an adapter and asserts which class came
// back, which proves the selection switch and nothing else — `save`, `delete`
// and `createSignedReadUrl` had never executed against anything. For an upload
// path that is the interesting half: a wrong option shape, an unsigned request,
// a key that does not round-trip, or a signed URL nobody can fetch all survive
// construction perfectly.
//
// It runs against MinIO from the test compose stack, so it needs no cloud
// account and no cloud credential. The `s3` adapter is deliberately the one
// covered: it is also the AWS, Cloudflare R2, DigitalOcean Spaces, Ceph and
// self-hosted story, so this is the broadest single path available. The GCS and
// Azure adapters remain construction-only, which is stated in the deployment
// contract rather than left for someone to discover.
const BUCKET = process.env.STORAGE_S3_BUCKET ?? 'nestjs-e2e-uploads';
const ENDPOINT = process.env.STORAGE_S3_ENDPOINT ?? 'http://localhost:9002';
const REGION = process.env.STORAGE_S3_REGION ?? 'us-east-1';

function buildUpload(
  contents: string,
  originalname: string,
  mimetype = 'image/png',
): Express.Multer.File {
  const buffer = Buffer.from(contents, 'utf8');
  return {
    buffer,
    originalname,
    mimetype,
    size: buffer.byteLength,
  } as Express.Multer.File;
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

    const storageConfiguration: Record<string, unknown> = {
      'storage.provider': 's3',
      'storage.s3.bucket': BUCKET,
      'storage.s3.region': REGION,
      'storage.s3.endpoint': ENDPOINT,
      'storage.s3.forcePathStyle': true,
      'storage.signedUrlTtlSeconds': 300,
      'storage.requestTimeoutMs': 15_000,
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

    storage = moduleRef.get(FileStorageService);
  });

  afterAll(() => {
    inspectionClient.destroy();
  });

  it('selects the s3 adapter', () => {
    expect(storage.providerName).toBe('s3');
  });

  it('uploads an object and returns a key that really exists', async () => {
    const stored = await storage.save(
      buildUpload('hello-object', 'photo.png'),
      'avatars',
    );

    expect(stored.storageKey).toMatch(/^avatars\/[0-9a-f-]{36}\.png$/);

    // Asserted against the BACKEND, not against the return value — the return
    // value would look identical if nothing had been written.
    const head = await inspectionClient.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: stored.storageKey }),
    );
    expect(head.ContentLength).toBe(
      Buffer.from('hello-object', 'utf8').byteLength,
    );
    expect(head.ContentType).toBe('image/png');
  });

  // Objects are private by default; a signed URL is the supported read path.
  it('mints a signed URL that actually fetches the object', async () => {
    const stored = await storage.save(
      buildUpload('signed-url-body', 'doc.png'),
      'avatars',
    );

    const signedUrl = await storage.createSignedReadUrl(stored.storageKey);
    const response = await fetch(signedUrl);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('signed-url-body');
  });

  // The signature IS the permission. Without it the bucket must refuse.
  it('refuses an unsigned read of the same object', async () => {
    const stored = await storage.save(
      buildUpload('private-body', 'private.png'),
      'avatars',
    );

    const unsignedUrl = `${ENDPOINT}/${BUCKET}/${stored.storageKey}`;
    const response = await fetch(unsignedUrl);

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('reports no public URL when no public base is configured', async () => {
    const stored = await storage.save(
      buildUpload('no-public-url', 'x.png'),
      'avatars',
    );

    expect(stored.publicUrl).toBeNull();
  });

  it('deletes an object it stored', async () => {
    const stored = await storage.save(
      buildUpload('delete-me', 'gone.png'),
      'avatars',
    );

    await storage.delete(stored.storageKey);

    await expect(
      inspectionClient.send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: stored.storageKey }),
      ),
    ).rejects.toThrow();
  });

  // Deletion is best-effort by contract: its callers are rollback and cleanup
  // paths, where a missing object means the write never completed.
  it('swallows a delete of something that is not there', async () => {
    await expect(
      storage.delete('avatars/00000000-0000-4000-8000-000000000000.png'),
    ).resolves.toBeUndefined();
  });

  // Two saves of the same bytes under the same subdirectory must not collide —
  // the identifying half of the name is server-minted, never caller-supplied.
  it('never overwrites an existing object', async () => {
    const first = await storage.save(buildUpload('same', 'a.png'), 'avatars');
    const second = await storage.save(buildUpload('same', 'a.png'), 'avatars');

    expect(first.storageKey).not.toBe(second.storageKey);
  });
});
