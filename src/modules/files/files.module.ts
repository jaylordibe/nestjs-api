import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { SignedReadUrlCacheModule } from '../../common/storage/signed-read-url-cache.module';
import { FileCleanupHandler } from './file-cleanup.handler';
import { FileProcessor } from './file-processor';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';

@Module({
  imports: [
    // Pictures are signed for every page that shows them.
    SignedReadUrlCacheModule,
    // Applies to every `FileInterceptor` in this module. The limits are what
    // stop a request from costing more than one bounded file: multer aborts
    // the stream the moment any is exceeded, before the rest is read.
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        // In memory: the bytes are inspected and re-encoded before anything is
        // written, so raw uploads never reach disk or storage.
        storage: memoryStorage(),
        // Browsers send file names as UTF-8; multer's default would decode
        // `résumé.pdf` as latin1 and store `rÃ©sumÃ©.pdf`.
        defParamCharset: 'utf8',
        limits: {
          fileSize: configService.getOrThrow<number>('files.maxUploadBytes'),
          files: 1,
          fields: 1,
          parts: 2,
          fieldSize: 256,
          headerPairs: 20,
        },
      }),
    }),
  ],
  controllers: [FilesController],
  providers: [
    FilesService,
    FileCleanupHandler,
    {
      provide: FileProcessor,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        new FileProcessor(
          configService.getOrThrow<number>('files.imageMaxPixels'),
        ),
    },
  ],
  exports: [FilesService],
})
export class FilesModule {}
