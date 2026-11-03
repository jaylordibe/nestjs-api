# File uploads

How a client attaches a file to anything — and how a fork adds a new place to
attach one. The code is the authority: `src/modules/files/`, the purpose table
in `src/modules/files/file-purpose.policy.ts`, and the lifecycle in
`src/common/enums/file-asset-status.enum.ts`.

## The contract: upload, then reference

Resource endpoints stay JSON. A file reaches one in two steps:

1. **`POST /api/files`** — `multipart/form-data` with exactly one `file` part and
   a `purpose`. Signed in (`@AuthenticatedOnly`), throttled to 30 per minute per
   user. Returns `201` with the file's `id`, its detected `contentType`, `kind`,
   size, dimensions, a display-safe `fileName`, and `expiresAt`.
2. **Reference the `id`** in the JSON create or update of the resource, before
   `expiresAt` (default 24 h, `FILE_UPLOAD_TTL_SECONDS`). Today:
   `PATCH /api/users/me { "profileImageFileId": "<id>" }`.

Several files are several `POST /api/files` calls, in parallel; each succeeds or
fails on its own. The same two steps work from a browser, a mobile app, n8n or
an MCP agent, and a future direct-to-storage upload can replace step 1 without
changing step 2.

| Response | `errorCode` | Meaning |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Unknown `purpose`, no `file` part, more than one file, extra fields |
| 413 | `PAYLOAD_TOO_LARGE` | Over the purpose's size limit, or over `FILE_UPLOAD_MAX_BYTES` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | The bytes are not a type the purpose accepts — whatever the client declared |
| 422 | `FILE_CONTENT_INVALID` | An accepted type that does not decode, or exceeds the pixel / dimension limits |
| 429 | `FILE_QUOTA_EXCEEDED` | 20 uploaded files not yet attached (`details.limit`). Attach one or wait for unused uploads to expire; retrying at once does not help |
| 503 | `EXTERNAL_SERVICE_UNAVAILABLE` | Storage refused the write; retry |

At the attach site: someone else's file, or one uploaded for a different
purpose, is `404 RESOURCE_NOT_FOUND` — indistinguishable from an id that does
not exist. The caller's own file that expired, was already attached, or is being
deleted is `409 FILE_NOT_ATTACHABLE`; once the cleanup job has removed an
expired file entirely, the same id answers 404. Either way: upload it again.

Single-file attribute semantics on PATCH: **omitted** = unchanged, **`null`** =
remove, **an id** = attach or replace. Re-sending the id that is already current
is a no-op `200`, so a retried request is safe.

An attached file comes back as `{ id, contentType, width, height, url,
urlExpiresAt }`. `url` is a signed URL minted only after the caller was
authorized to read the resource; read the resource again for a fresh one. If
storage cannot sign at that moment, the file is reported as absent (`null`)
rather than failing the response — a login or token refresh never fails because
a picture could not be signed.

## What happens to the bytes

- The type is identified from the bytes (`file-type`: magic numbers, and the
  parts inside an Office ZIP), never from the part's `Content-Type` or the
  file name. It must be in the purpose's allowlist.
- **Images** (JPEG, PNG, WebP) are decoded by `sharp` with a pixel limit
  checked from the header (`FILE_IMAGE_MAX_PIXELS`), auto-oriented, scaled down
  to the purpose's maximum dimension, and re-encoded in the same format. EXIF,
  GPS and ICC metadata are dropped. Served `inline`.
- **Documents** (PDF, DOCX, XLSX, PPTX) are stored byte-for-byte — there is no
  sanitiser — and always served as `Content-Disposition: attachment`.
  Macro-enabled and legacy binary Office formats are not accepted.
- Raw bytes live only in request memory. Nothing unprocessed is written
  anywhere.
- Every object is written `Cache-Control: private, max-age=3600`, so no shared
  cache keeps a copy after the signed URL that fetched it expires. A purpose
  whose files no cache may keep, the reader's browser included (an identity
  document), sets `cacheControl: NO_STORE_CACHE_CONTROL` in its policy.

## Lifecycle

One table, `file_assets`, holds each file's details and its state:

```
processing ──► ready ──► attached ──► deleting ──► (row deleted)
     │           │                        ▲
     └───────────┴── failure / expiry ────┘
```

- The row is written **before** the object, with its key, so an object never
  exists without a row naming it.
- `ready` → `attached` is one conditional `UPDATE` (owner, purpose, `ready`,
  not expired) inside the attach site's transaction: an id is consumed once.
- Replacing, removing, or erasing the account marks the old file `deleting` in
  the same transaction that clears the reference.
- The `files.cleanup.v1` job (every 10 minutes, `MAINTENANCE` queue) claims
  expired `ready` files and stale `processing` rows into `deleting`, then
  deletes object first, row second. A failed object delete keeps the row and
  increments `delete_attempts`; the next run retries it, and from 5 attempts on
  each failure logs at error level.

**Ownership:** until attached, a file belongs to its uploader and only they can
attach it. Once attached, it belongs to exactly one reference — each
referencing column is unique and `RESTRICT`, so a referenced file's row cannot
be deleted. Files are never shared between resources; reusing an image means
uploading it again.

## Adding a purpose

1. A value in `FilePurpose` (`src/common/enums/file-purpose.enum.ts`).
2. An entry in `FILE_PURPOSE_POLICIES`: byte limit, image maximum dimension,
   storage subdirectory (a code constant), cache rule, and accepted types.

No migration. A new image type also needs a case in `FileProcessor.encoderFor`, or
it fails loudly rather than being stored un-re-encoded.

## Attaching files to a new resource

The files module knows no resource; the domain service owns the reference and
calls `FilesService` inside its own transaction. Take every parent lock first:
`file_assets` rows are always locked last (`row-lock.util.ts`).

**One file** (like the profile picture): a nullable, unique `<name>FileId`
column with a `RESTRICT` foreign key to `file_assets`. Copy
`UsersService.applyProfileImageChange`: lock the parent row, return early on
omitted or unchanged, `claimForAttachment` the new id, `markDeleting` the old
one.

**Several files** (a gallery): a mapping table owned by the domain, e.g.

```prisma
model TourFile {
  id          String  @id @default(uuid()) @db.Uuid
  tourId      String  @map("tour_id") @db.Uuid      // FK tours, Cascade
  fileAssetId String  @unique @map("file_asset_id") @db.Uuid // FK file_assets, Restrict
  position    Int
  isPrimary   Boolean @default(false) @map("is_primary")
  // createdAt / createdBy …
  @@index([tourId, position])
  @@map("tour_files")
}
```

Accept the ordered list declaratively (`PUT …/files` with
`[{ id? } | { fileId }]`), lock the parent row, claim each new id, delete the
mapping rows not in the list and `markDeleting` their files, then rewrite
positions. A declarative list makes a retry converge. If the resource is
workspace-scoped, take the workspace from the authorized route — never from the
file.

Responses: build them through one method that calls
`FilesService.findAttachedResponses`, and only for records the caller was
authorized to read.

## Not here

No virus scanning or document sanitisation, no thumbnails or variants, no
direct-to-storage (presigned) upload, no endpoint to read or delete a file by its
own id. The deployment edge must allow request bodies of at least
`FILE_UPLOAD_MAX_BYTES` on `POST /api/files`.
