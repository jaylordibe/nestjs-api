// Builds a `Content-Disposition` header value for a stored object (RFC 6266).
//
// `inline` lets a browser render the object (re-encoded images); `attachment`
// makes it download instead (documents, whose content the server does not
// sanitise — a PDF opened inside the bucket's origin is active content).
//
// The file name is user content. It is reduced to a printable ASCII fallback
// for `filename=` (quotes and backslashes removed, so it cannot break out of
// the quoted string) and carried in full, percent-encoded, in `filename*=`,
// which every current browser prefers.
export type ContentDispositionType = 'inline' | 'attachment';

const NON_PRINTABLE_ASCII = /[^\x20-\x7e]/g;
const QUOTED_STRING_UNSAFE = /["\\]/g;

export function buildContentDisposition(
  dispositionType: ContentDispositionType,
  fileName: string,
): string {
  const asciiFallback =
    fileName
      .replace(NON_PRINTABLE_ASCII, '_')
      .replace(QUOTED_STRING_UNSAFE, '_') || 'file';
  // encodeURIComponent leaves ' ( ) * ! unescaped; RFC 5987 attr-char does not
  // allow them, so they are escaped by hand.
  const encoded = encodeURIComponent(fileName).replace(
    /['()*!]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${dispositionType}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
