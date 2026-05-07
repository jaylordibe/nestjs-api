import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as path from 'path';
import {
  FileStorageAdapter,
  SavedFile,
} from './file-storage-adapter.interface';

// Used when STORAGE_PROVIDER=stub (default for local dev and test env).
// Buffers are dropped — no real persistence — and the service logs what
// would have been uploaded so flow integration is observable. URLs are
// shaped `stub://<subdir>/<uuid>.<ext>` so caller code that splits / joins
// or runs `deleteByUrl` against them still works against the stub.
@Injectable()
export class StubFileStorageAdapter implements FileStorageAdapter {
  private static readonly URL_PREFIX = 'stub://';
  private readonly logger = new Logger(StubFileStorageAdapter.name);

  save(file: Express.Multer.File, subdir: string): Promise<SavedFile> {
    const ext = path.extname(file.originalname).toLowerCase();
    const cleanSubdir = subdir.replace(/^\/+|\/+$/g, '');
    const objectName = cleanSubdir
      ? `${cleanSubdir}/${randomUUID()}${ext}`
      : `${randomUUID()}${ext}`;
    this.logger.log(
      `[storage:stub] saved key=${objectName} size=${file.size} mime=${file.mimetype}`,
    );
    return Promise.resolve({
      storageKey: objectName,
      url: `${StubFileStorageAdapter.URL_PREFIX}${objectName}`,
    });
  }

  delete(storageKey: string): Promise<void> {
    this.logger.log(`[storage:stub] deleted key=${storageKey}`);
    return Promise.resolve();
  }

  deleteByUrl(url: string): Promise<void> {
    if (!url.startsWith(StubFileStorageAdapter.URL_PREFIX)) {
      return Promise.resolve();
    }
    return this.delete(url.slice(StubFileStorageAdapter.URL_PREFIX.length));
  }
}
