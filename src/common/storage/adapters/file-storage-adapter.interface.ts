// An object that has been written to storage.
//
// `storageKey` is the CANONICAL IDENTIFIER and the thing a database row should
// hold. `publicUrl` is a convenience that is null far more often than not.
export interface StoredObject {
  // Backend-internal object key (e.g. "avatars/<uuid>.png"). Server-generated,
  // never caller-chosen — see `buildObjectName`. Store THIS, not a URL: a URL
  // embeds the bucket, the provider and the access model, so a row holding one
  // cannot survive a bucket rename, a CDN change or a move between providers.
  storageKey: string;
  // A directly-fetchable URL, or **null when the bucket is not public**.
  //
  // Null is the default and the safe case. It is non-null only when
  // STORAGE_PUBLIC_URL_BASE is configured, which is an explicit assertion by
  // the operator that objects in this bucket are world-readable (or fronted by
  // a CDN that makes them so). Nothing in this application makes a bucket
  // public, and nothing assumes one is.
  publicUrl: string | null;
}

// The storage capability the application depends on. Deliberately small, and
// deliberately free of any provider vocabulary — no bucket, no container, no
// blob, no region. Concrete adapters live alongside this interface and are
// selected at the module level via the FILE_STORAGE_ADAPTER DI token, so
// domain code neither knows nor can discover which backend is active.
//
// A provider SDK may be imported ONLY by its own adapter file. That boundary is
// what keeps the application deployable to a different cloud without touching a
// line of business logic.
export interface FileStorageAdapter {
  // Identifies the active backend for logs and for the provider-selection
  // test. Not for branching on — anything that would branch belongs behind
  // this interface instead.
  readonly providerName: string;

  // Writes the file under a server-generated object name inside `subdirectory`
  // (a code-chosen constant, never request input) and returns its key.
  save(file: Express.Multer.File, subdirectory: string): Promise<StoredObject>;

  // Deletes by object key. Best-effort — implementations swallow "not found",
  // because the callers are rollback and cleanup paths where a missing object
  // just means the write never completed.
  delete(storageKey: string): Promise<void>;

  // A short-lived, read-only URL for one object.
  //
  // **The caller MUST have authorized the request before calling this.** A
  // signed URL is a bearer credential: it grants read access to anyone holding
  // it, for as long as it lives, with no further check. This method performs no
  // authorization of its own and cannot — it has no idea who is asking.
  //
  // `ttlSeconds` is clamped by `FileStorageService` before it arrives here.
  createSignedReadUrl(storageKey: string, ttlSeconds: number): Promise<string>;

  // The public URL for a key, or null when no public base is configured.
  // Pure — it builds a string and performs no I/O.
  resolvePublicUrl(storageKey: string): string | null;
}

export const FILE_STORAGE_ADAPTER = Symbol('FILE_STORAGE_ADAPTER');
