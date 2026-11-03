import { MAXIMUM_SIGNED_URL_TTL_SECONDS } from '../../util/signed-url-ttl.util';

// The bytes and response headers of one object about to be written.
//
// Every field is SERVER-DETERMINED. `contentType` is what the server decided
// the content is after inspecting it — never the `Content-Type` a client
// declared for its multipart part, which an attacker sets to `image/png` on an
// HTML page — and `contentDisposition` is built from a sanitised name
// (`buildContentDisposition`). An adapter stores them as given.
export interface ObjectContent {
  body: Buffer;
  contentType: string;
  contentDisposition: string;
}

// The `Cache-Control` every adapter writes. Objects are private: the only read
// path is a signed URL, which lives at most `MAXIMUM_SIGNED_URL_TTL_SECONDS`.
// `private` keeps a shared proxy or CDN from storing the response, and the
// max-age stops a browser cache from outliving the longest URL that could have
// fetched it — a `public, max-age=<a year>` header would let a cached copy keep
// serving after the signature expired and the reader lost access.
export const PRIVATE_OBJECT_CACHE_CONTROL = `private, max-age=${MAXIMUM_SIGNED_URL_TTL_SECONDS}`;

// The storage capability the application depends on. Deliberately small, and
// deliberately free of any provider vocabulary — no bucket, no container, no
// blob, no region. Concrete adapters live alongside this interface and are
// selected at the module level via the FILE_STORAGE_ADAPTER DI token, so
// domain code neither knows nor can discover which backend is active.
//
// A provider SDK may be imported ONLY by its own adapter file. That boundary is
// what keeps the application deployable to a different cloud without touching a
// line of domain logic.
export interface FileStorageAdapter {
  // Identifies the active backend for logs and for the provider-selection
  // test. Not for branching on — anything that would branch belongs behind
  // this interface instead.
  readonly providerName: string;

  // Writes `content` under `storageKey`. The key comes from
  // `FileStorageService.createKey` — server-minted, never request input — and
  // the caller records it in the database BEFORE calling this, so no object can
  // exist that no row knows about.
  put(storageKey: string, content: ObjectContent): Promise<void>;

  // Deletes by object key. Deleting a key that does not exist succeeds — the
  // write it names may never have completed — but every OTHER failure throws,
  // so a cleanup job can keep the row and retry instead of forgetting an
  // object it failed to remove.
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
}

export const FILE_STORAGE_ADAPTER = Symbol('FILE_STORAGE_ADAPTER');
