import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FileStorageModule } from './file-storage.module';
import { FileStorageService } from './file-storage.service';
import { MAXIMUM_SIGNED_URL_TTL_SECONDS } from '../util/signed-url-ttl.util';

// Proves the abstraction actually abstracts: every supported provider resolves
// to a working `FileStorageService`, selected purely by `STORAGE_PROVIDER`, with
// no call site and no other module changing between them. That is the property
// that makes this template deployable to a different cloud without an
// application rewrite, and it is the one that would silently rot.
//
// The adapters are constructed for real. None of them contacts its backend at
// construction time, so this needs no cloud account and no credential — it does
// exercise each SDK's client constructor, which is where a wrong option shape
// would surface.
describe('FileStorageModule provider selection', () => {
  const STORAGE_KEYS = [
    'STORAGE_PROVIDER',
    'STORAGE_PUBLIC_URL_BASE',
    'STORAGE_S3_BUCKET',
    'STORAGE_S3_REGION',
    'STORAGE_GCS_BUCKET',
    'STORAGE_GCS_PROJECT_ID',
    'STORAGE_AZURE_ACCOUNT_NAME',
    'STORAGE_AZURE_CONTAINER',
  ] as const;

  const originalEnvironment: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of STORAGE_KEYS) {
      originalEnvironment[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of STORAGE_KEYS) {
      const originalValue = originalEnvironment[key];
      if (originalValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValue;
      }
    }
  });

  // A hand-built ConfigService over the storage subtree only, supplied through
  // a @Global() module exactly as the real ConfigModule is. The real one would
  // drag the whole Joi schema — and therefore a database and a Redis — into a
  // test about which class gets constructed.
  //
  // The REAL `FileStorageModule` is imported rather than reconstructed, so this
  // exercises the actual selection switch and the actual dynamic imports.
  async function buildStorageService(
    storageConfiguration: Record<string, unknown>,
  ): Promise<FileStorageService> {
    const configServiceStub = {
      get: (path: string) => storageConfiguration[path],
      getOrThrow: (path: string) => {
        const value = storageConfiguration[path];
        if (value === undefined) {
          throw new Error(`Missing configuration: ${path}`);
        }
        return value;
      },
    };

    @Global()
    @Module({
      providers: [{ provide: ConfigService, useValue: configServiceStub }],
      exports: [ConfigService],
    })
    class StorageConfigurationTestModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [StorageConfigurationTestModule, FileStorageModule],
    }).compile();

    return moduleRef.get(FileStorageService);
  }

  const BASE_CONFIGURATION = {
    'storage.signedUrlTtlSeconds': 300,
    // Every real adapter reads this at construction time — the bound on a
    // single storage call, so a slow backend cannot hold a database connection
    // open indefinitely.
    'storage.requestTimeoutMs': 15_000,
  };

  it('selects the stub adapter by default', async () => {
    const service = await buildStorageService({
      ...BASE_CONFIGURATION,
      'storage.provider': 'stub',
    });

    expect(service.providerName).toBe('stub');
  });

  it('selects the S3 adapter', async () => {
    const service = await buildStorageService({
      ...BASE_CONFIGURATION,
      'storage.provider': 's3',
      'storage.s3.bucket': 'uploads',
      'storage.s3.region': 'eu-central-1',
    });

    expect(service.providerName).toBe('s3');
  });

  // The S3 adapter is the self-hosted story too — MinIO, Ceph, R2 — so the
  // endpoint override must not be AWS-only.
  it('selects the S3 adapter against an S3-compatible endpoint', async () => {
    const service = await buildStorageService({
      ...BASE_CONFIGURATION,
      'storage.provider': 's3',
      'storage.s3.bucket': 'uploads',
      'storage.s3.region': 'us-east-1',
      'storage.s3.endpoint': 'http://minio:9000',
      'storage.s3.forcePathStyle': true,
    });

    expect(service.providerName).toBe('s3');
  });

  it('selects the GCS adapter', async () => {
    const service = await buildStorageService({
      ...BASE_CONFIGURATION,
      'storage.provider': 'gcs',
      'storage.gcs.bucket': 'uploads',
      'storage.gcs.projectId': 'example-project',
    });

    expect(service.providerName).toBe('gcs');
  });

  it('selects the Azure adapter', async () => {
    const service = await buildStorageService({
      ...BASE_CONFIGURATION,
      'storage.provider': 'azure',
      'storage.azure.accountName': 'examplestorage',
      'storage.azure.container': 'uploads',
    });

    expect(service.providerName).toBe('azure');
  });

  describe('public-URL policy', () => {
    // The default must be "not public". A bucket is only readable because an
    // operator said so, and this is where that assertion enters the system.
    it('reports no public URL when no public base is configured', async () => {
      const service = await buildStorageService({
        ...BASE_CONFIGURATION,
        'storage.provider': 's3',
        'storage.s3.bucket': 'uploads',
        'storage.s3.region': 'eu-central-1',
      });

      expect(service.resolvePublicUrl('avatars/abc.png')).toBeNull();
    });

    it('builds a public URL only once a base is declared', async () => {
      const service = await buildStorageService({
        ...BASE_CONFIGURATION,
        'storage.provider': 's3',
        'storage.s3.bucket': 'uploads',
        'storage.s3.region': 'eu-central-1',
        'storage.publicUrlBase': 'https://cdn.example.com',
      });

      expect(service.resolvePublicUrl('avatars/abc.png')).toBe(
        'https://cdn.example.com/avatars/abc.png',
      );
    });
  });

  describe('signed URLs', () => {
    it('mints a bounded, expiring URL through the stub', async () => {
      const service = await buildStorageService({
        ...BASE_CONFIGURATION,
        'storage.provider': 'stub',
      });

      const signedUrl = await service.createSignedReadUrl('avatars/abc.png');

      expect(signedUrl).toContain('avatars/abc.png');
      expect(signedUrl).toMatch(/expires=\d+/);
    });

    // The clamp lives in the service, not the adapters, so no provider can be
    // talked into a long-lived URL by a call site passing a big number.
    it('clamps a call site asking for a day-long URL', async () => {
      const service = await buildStorageService({
        ...BASE_CONFIGURATION,
        'storage.provider': 'stub',
      });

      const nowSeconds = Math.floor(Date.now() / 1000);
      const signedUrl = await service.createSignedReadUrl(
        'avatars/abc.png',
        86_400,
      );

      const expiresAtSeconds = Number(
        /expires=(\d+)/.exec(signedUrl)?.[1] ?? '0',
      );
      // Asserted as an equality against the ceiling, not `<= 3600`: the loose
      // form also passes for a clamp accidentally rewritten to return the 30s
      // floor for every request, which would silently break every download.
      expect(expiresAtSeconds - nowSeconds).toBeCloseTo(
        MAXIMUM_SIGNED_URL_TTL_SECONDS,
        -1,
      );
    });
  });
});
