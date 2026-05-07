import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FILE_STORAGE_ADAPTER,
  FileStorageAdapter,
} from './adapters/file-storage-adapter.interface';
import { S3FileStorageAdapter } from './adapters/s3-file-storage.adapter';
import { StubFileStorageAdapter } from './adapters/stub-file-storage.adapter';
import { FileStorageService } from './file-storage.service';

// Provider selection is driven by `STORAGE_PROVIDER` in env (validated by
// Joi to one of: stub, s3). Tests and local dev use `stub` by default —
// no real uploads happen and the URLs are shaped `stub://...` so flow
// integration is observable in logs. Staging/prod set `STORAGE_PROVIDER=s3`
// (plus STORAGE_S3_BUCKET, STORAGE_S3_REGION, AWS credentials in the
// standard chain) to route through S3.
//
// Only the selected adapter is instantiated — the unselected one's
// constructor never runs. This matters because S3FileStorageAdapter reads
// required config at construction time; if it were always built, the stub
// path would fail at boot whenever S3 config isn't set.
@Global()
@Module({
  providers: [
    {
      provide: FILE_STORAGE_ADAPTER,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): FileStorageAdapter => {
        const provider = configService.get<string>('storage.provider');
        const logger = new Logger('FileStorageModule');
        if (provider === 's3') {
          logger.log('File storage provider: s3');
          return new S3FileStorageAdapter(configService);
        }
        logger.log('File storage provider: stub (no real uploads)');
        return new StubFileStorageAdapter();
      },
    },
    FileStorageService,
  ],
  exports: [FileStorageService],
})
export class FileStorageModule {}
