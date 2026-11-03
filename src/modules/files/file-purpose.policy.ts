import { FileKind } from '../../common/enums/file-kind.enum';
import { FilePurpose } from '../../common/enums/file-purpose.enum';
import { PRIVATE_OBJECT_CACHE_CONTROL } from '../../common/storage/adapters/file-storage-adapter.interface';

// One accepted content type: what the inspected bytes must be, how they are
// handled, and the extension the stored object and download name carry.
export interface AcceptedContentType {
  contentType: string;
  kind: FileKind;
  extension: string;
}

const MEBIBYTE = 1024 * 1024;

// How many uploaded-but-unattached files one person may hold at once. Bounds
// the storage a single account can occupy with files nothing uses; they
// expire after `FILE_UPLOAD_TTL_SECONDS` anyway.
export const MAX_UNATTACHED_FILES_PER_USER = 20;

const JPEG: AcceptedContentType = {
  contentType: 'image/jpeg',
  kind: FileKind.IMAGE,
  extension: 'jpg',
};
const PNG: AcceptedContentType = {
  contentType: 'image/png',
  kind: FileKind.IMAGE,
  extension: 'png',
};
const WEBP: AcceptedContentType = {
  contentType: 'image/webp',
  kind: FileKind.IMAGE,
  extension: 'webp',
};
const PDF: AcceptedContentType = {
  contentType: 'application/pdf',
  kind: FileKind.DOCUMENT,
  extension: 'pdf',
};
const DOCX: AcceptedContentType = {
  contentType:
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  kind: FileKind.DOCUMENT,
  extension: 'docx',
};
const XLSX: AcceptedContentType = {
  contentType:
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  kind: FileKind.DOCUMENT,
  extension: 'xlsx',
};
const PPTX: AcceptedContentType = {
  contentType:
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  kind: FileKind.DOCUMENT,
  extension: 'pptx',
};

export interface FilePurposePolicy {
  // Bytes, before processing. The effective limit is the lower of this and
  // `FILE_UPLOAD_MAX_BYTES`.
  maxBytes: number;
  // Re-encoded images are scaled down to fit this square; never enlarged.
  imageMaxDimension: number;
  // Code-chosen object-name prefix (`buildObjectName`), never request input.
  storageSubdirectory: string;
  // `PRIVATE_OBJECT_CACHE_CONTROL`, or `NO_STORE_CACHE_CONTROL` for a file no
  // cache may keep (an identity document, a signed contract).
  cacheControl: string;
  // Keyed by the content type the bytes were DETECTED as — never by the type
  // a client declared or the extension it named.
  accepted: ReadonlyMap<string, AcceptedContentType>;
}

function acceptedTypes(
  ...types: AcceptedContentType[]
): ReadonlyMap<string, AcceptedContentType> {
  return new Map(types.map((type) => [type.contentType, type]));
}

// What each purpose accepts. A new purpose is an enum value plus an entry here.
//
// GIF is absent on purpose: animated images would need a separate pipeline,
// and a still image has no reason to be a GIF. Macro-enabled Office formats
// (docm, xlsm, pptm) and legacy binary ones (doc, xls, ppt) are absent too —
// they are what makes an Office document dangerous to whoever opens it.
export const FILE_PURPOSE_POLICIES: Record<FilePurpose, FilePurposePolicy> = {
  [FilePurpose.PROFILE_IMAGE]: {
    maxBytes: 10 * MEBIBYTE,
    imageMaxDimension: 1024,
    storageSubdirectory: 'files/profile-images',
    cacheControl: PRIVATE_OBJECT_CACHE_CONTROL,
    accepted: acceptedTypes(JPEG, PNG, WEBP),
  },
  [FilePurpose.DOCUMENT]: {
    maxBytes: 25 * MEBIBYTE,
    imageMaxDimension: 4096,
    storageSubdirectory: 'files/documents',
    cacheControl: PRIVATE_OBJECT_CACHE_CONTROL,
    accepted: acceptedTypes(JPEG, PNG, WEBP, PDF, DOCX, XLSX, PPTX),
  },
};
