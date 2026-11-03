// How a file's content was handled. `IMAGE` was decoded and re-encoded by the
// server (metadata stripped, served inline); `DOCUMENT` is stored byte-for-byte
// and always served as a download.
export enum FileKind {
  IMAGE = 'image',
  DOCUMENT = 'document',
}
