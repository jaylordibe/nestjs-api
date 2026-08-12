import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FILE_STORAGE_ADAPTER,
  FileStorageAdapter,
} from './adapters/file-storage-adapter.interface';
import { FileStorageService } from './file-storage.service';

// Adapter selection, driven by `STORAGE_PROVIDER` (validated by Joi to one of:
// stub, s3, gcs, azure).
//
// ── Why the adapters are loaded lazily ───────────────────────────────────────
// A static `import` at the top of this file would pull all four provider SDKs
// into the process at boot — roughly 40 MB of AWS, Google and Azure client code
// — on every instance, in every environment, whichever single provider is
// actually configured. That cost lands on every cold start, which is exactly
// the wrong place to pay it on a platform that scales container instances up
// and down. With the `require` calls below, only the selected adapter's module
// graph is ever loaded: an S3 deployment never reads a byte of the Google SDK.
//
// `require` rather than `await import()`: this package compiles to CommonJS, so
// `require` is already lazy and behaves identically under Node, ts-node and
// Jest. A real dynamic `import()` survives compilation under `module: nodenext`
// and then throws "A dynamic import callback was invoked without
// --experimental-vm-modules" inside Jest — which would take the entire e2e
// suite with it, since every test app builds this module. The
// `typeof import(...)` casts are TYPE-ONLY and emit nothing, so laziness costs
// no type safety.
//
// The unselected adapters' CONSTRUCTORS never run either, which matters
// independently: each real adapter reads its own required config at
// construction time, so a stub deployment would otherwise fail at boot over S3
// settings it does not use.
//
// A fork that will only ever use one provider can delete the other three
// adapter files, their branches below, and their SDKs from `package.json`. That
// is one small commit, and nothing outside this folder notices — which is the
// point of the abstraction.

/* eslint-disable @typescript-eslint/no-require-imports */

function createS3Adapter(configService: ConfigService): FileStorageAdapter {
  const { S3FileStorageAdapter } =
    require('./adapters/s3-file-storage.adapter') as typeof import('./adapters/s3-file-storage.adapter');
  return new S3FileStorageAdapter(configService);
}

function createGcsAdapter(configService: ConfigService): FileStorageAdapter {
  const { GcsFileStorageAdapter } =
    require('./adapters/gcs-file-storage.adapter') as typeof import('./adapters/gcs-file-storage.adapter');
  return new GcsFileStorageAdapter(configService);
}

function createAzureAdapter(configService: ConfigService): FileStorageAdapter {
  const { AzureFileStorageAdapter } =
    require('./adapters/azure-file-storage.adapter') as typeof import('./adapters/azure-file-storage.adapter');
  return new AzureFileStorageAdapter(configService);
}

function createStubAdapter(): FileStorageAdapter {
  const { StubFileStorageAdapter } =
    require('./adapters/stub-file-storage.adapter') as typeof import('./adapters/stub-file-storage.adapter');
  return new StubFileStorageAdapter();
}

/* eslint-enable @typescript-eslint/no-require-imports */

@Global()
@Module({
  providers: [
    {
      provide: FILE_STORAGE_ADAPTER,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): FileStorageAdapter => {
        const provider = configService.getOrThrow<string>('storage.provider');
        const logger = new Logger('FileStorageModule');

        switch (provider) {
          case 's3':
            logger.log('File storage provider: s3');
            return createS3Adapter(configService);
          case 'gcs':
            logger.log('File storage provider: gcs');
            return createGcsAdapter(configService);
          case 'azure':
            logger.log('File storage provider: azure');
            return createAzureAdapter(configService);
          default:
            logger.log('File storage provider: stub (no real uploads)');
            return createStubAdapter();
        }
      },
    },
    FileStorageService,
  ],
  exports: [FileStorageService],
})
export class FileStorageModule {}
