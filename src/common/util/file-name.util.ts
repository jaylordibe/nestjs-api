// Reduces a client-supplied file name to a safe display form.
//
// The name is user content: it is shown back to people and used as the
// download name, never as a storage key and never logged. What is removed is
// what could do harm when it is echoed — path segments, control characters
// (CR/LF in a header, terminal escapes) — and the extension is replaced with
// the one the server derived from the inspected content, so a file named
// `invoice.pdf.exe` that is really a PDF downloads as `invoice.pdf.pdf`, not
// as something a desktop would execute.
const MAXIMUM_BASE_NAME_LENGTH = 200;
// C0 and C1 control characters, DEL, and the Unicode bidi overrides that can
// make `exe.pdf` display as `fdp.exe`.
const UNSAFE_CHARACTERS = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu;

export function sanitizeFileName(
  originalName: string | undefined,
  extension: string,
): string {
  const lastSegment = (originalName ?? '').split(/[/\\]/).pop() ?? '';
  const cleaned = lastSegment
    .normalize('NFC')
    .replace(UNSAFE_CHARACTERS, '')
    .trim();
  const dotIndex = cleaned.lastIndexOf('.');
  // Cut by code point, not UTF-16 unit: halving an emoji's surrogate pair
  // leaves a string `encodeURIComponent` refuses.
  const baseName = Array.from(
    dotIndex > 0 ? cleaned.slice(0, dotIndex) : cleaned,
  )
    .slice(0, MAXIMUM_BASE_NAME_LENGTH)
    .join('')
    .trim();
  return `${baseName || 'file'}.${extension}`;
}
