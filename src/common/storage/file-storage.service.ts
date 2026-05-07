import { Inject, Injectable } from '@nestjs/common';
import {
  FILE_STORAGE_ADAPTER,
  SavedFile,
} from './adapters/file-storage-adapter.interface';
import type { FileStorageAdapter } from './adapters/file-storage-adapter.interface';

// Facade used by the rest of the app. Adapter selection (stub / s3)
// happens in FileStorageModule's provider factory so call sites are
// decoupled from the storage backend.
//
// Typical flow when persisting a user upload:
//   1. fileStorageService.save(file, 'avatars') → { url, storageKey }
//   2. write `url` into the DB row
//   3. on DB failure, fileStorageService.delete(storageKey) to roll back
//
// Use deleteByUrl() in resource `remove()` paths so the storage backend
// doesn't accumulate orphans when DB rows are deleted.
@Injectable()
export class FileStorageService {
  constructor(
    @Inject(FILE_STORAGE_ADAPTER) private readonly adapter: FileStorageAdapter,
  ) {}

  save(file: Express.Multer.File, subdir: string): Promise<SavedFile> {
    return this.adapter.save(file, subdir);
  }

  delete(storageKey: string): Promise<void> {
    return this.adapter.delete(storageKey);
  }

  deleteByUrl(url: string): Promise<void> {
    return this.adapter.deleteByUrl(url);
  }
}
