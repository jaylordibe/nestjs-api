export interface SavedFile {
  // Public URL the client should use to fetch this file.
  url: string;
  // Backend-internal object key (e.g. "<uuid>.png" or
  // "<subdir>/<uuid>.png"). Kept around so callers can roll back a saved
  // file when a downstream step (DB write) fails after the save.
  storageKey: string;
}

// Concrete adapters live alongside this interface and are swapped at the
// module level via the FILE_STORAGE_ADAPTER DI token. Adapters receive the
// raw multer file and decide where it lives — call sites should not care
// which storage backend is active.
export interface FileStorageAdapter {
  // Saves the file under the given subdir (or flat at the root when subdir
  // is empty) and returns the public URL plus the internal object key.
  save(file: Express.Multer.File, subdir: string): Promise<SavedFile>;

  // Deletes a file by its object key (the value previously returned from
  // save()). Best-effort — implementations should swallow "not found"
  // errors because the only caller is rollback cleanup, where a missing
  // file just means the save didn't complete in the first place.
  delete(storageKey: string): Promise<void>;

  // Reverses a public URL we previously returned from save() back to a
  // delete. URLs that don't belong to this storage (e.g. a CDN URL hand-
  // entered on a row imported from elsewhere) are silently ignored — we
  // only delete files we own.
  deleteByUrl(url: string): Promise<void>;
}

export const FILE_STORAGE_ADAPTER = Symbol('FILE_STORAGE_ADAPTER');
