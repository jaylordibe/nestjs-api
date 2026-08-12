import { randomUUID } from 'crypto';

// Builds the object name an uploaded file is stored under.
//
// The name is SERVER-GENERATED, always. The only thing a caller contributes is
// the subdirectory — a literal chosen in code (`'avatars'`, `'businesses'`),
// never a value taken from a request — and the file extension, which is
// lowercased and carried purely so the object is recognisable in a bucket
// listing. The identifying part is a fresh UUID, so no caller can choose where
// an object lands, overwrite an existing one, or probe for another tenant's
// object by guessing its name.
//
// The subdirectory is validated rather than merely trimmed. Object stores treat
// the name as an opaque string with no notion of a parent directory, so `..`
// does not "escape" anywhere — but the same name is concatenated into a public
// URL by `resolvePublicUrl` and signed into one by `createSignedReadUrl`, and a
// name containing `..`, `//` or a leading `/` produces a URL that a CDN, a proxy
// or a browser may normalise differently from the store. Refusing the shape
// outright is cheaper than reasoning about which layer normalises what.
const SAFE_SUBDIRECTORY_PATTERN = /^[a-z0-9][a-z0-9/_-]*$/;

// The extension is the ONE part of the name that comes from the client — every
// adapter passes `path.extname(file.originalname)`, and the upload filters
// check the declared MIME type, never the filename. So it is whitelisted rather
// than trusted.
//
// It cannot produce a path escape (`path.extname` returns at most the last
// dot-segment of the last path segment), but it can carry `?` or `#`, and the
// object name is concatenated straight into a URL — `avatars/<uuid>.p?g` yields
// a URL whose `?g` is parsed as a query string, so the key stops round-tripping.
// Anything that is not a short alphanumeric suffix is dropped: the object is
// still stored, just without a decorative extension.
const SAFE_FILE_EXTENSION_PATTERN = /^\.[a-z0-9]{1,10}$/;

function sanitizeFileExtension(fileExtension: string): string {
  return SAFE_FILE_EXTENSION_PATTERN.test(fileExtension) ? fileExtension : '';
}

export function buildObjectName(
  subdirectory: string,
  fileExtension: string,
): string {
  const trimmedSubdirectory = subdirectory.replace(/^\/+|\/+$/g, '');
  const safeExtension = sanitizeFileExtension(fileExtension);

  // An empty subdirectory is supported and means "store flat at the bucket
  // root". Without the trim above, the object name would carry a leading `/`,
  // which object stores accept as a literal character and which breaks the
  // public URL.
  if (trimmedSubdirectory.length === 0) {
    return `${randomUUID()}${safeExtension}`;
  }

  if (
    !SAFE_SUBDIRECTORY_PATTERN.test(trimmedSubdirectory) ||
    trimmedSubdirectory.includes('..') ||
    trimmedSubdirectory.includes('//')
  ) {
    throw new Error(
      `Unsafe storage subdirectory "${subdirectory}". Use lowercase letters, digits, "-", "_" and "/" only — subdirectories are code-chosen constants, never request input.`,
    );
  }

  return `${trimmedSubdirectory}/${randomUUID()}${safeExtension}`;
}
