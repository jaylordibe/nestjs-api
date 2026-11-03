// The lifecycle of a stored file (`file_assets.status`).
//
//   processing ──► ready ──► attached ──► deleting ──► (row removed)
//        │           │                       ▲
//        └───────────┴──── on failure / expiry ┘
//
// `PROCESSING` exists only for the length of one `POST /files` request: the row
// is written first so the object's key is recorded before the object is. A row
// still `processing` long after that is a request that died mid-way, and the
// cleanup job reclaims it.
//
// `READY` is the only state a file can be attached from, and only while
// `expiresAt` is in the future. The transition out of it is a conditional
// UPDATE, never a read-then-write, so an id is consumed exactly once and the
// cleanup job's claim and an attach cannot both win.
//
// There is deliberately no `EXPIRED` or `FAILED`: expiry is the timestamp, and
// a file that failed or expired goes straight to `DELETING`.
export enum FileAssetStatus {
  PROCESSING = 'processing',
  READY = 'ready',
  ATTACHED = 'attached',
  DELETING = 'deleting',
}
