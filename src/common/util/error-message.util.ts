// Normalizes a caught `unknown` into a loggable string. TypeScript types every
// `catch` binding as `unknown`, so every log line that wants the message has to
// narrow first — this is that narrowing, once, instead of at each catch site.
//
// Non-Error throws (a string, a rejected non-Error, an object) stringify rather
// than vanish: a log line reading "[object Object]" is a bad log line, but a
// swallowed failure is a bug.
//
// The `cause` chain is appended because Node hides the useful half of a network
// failure there. `fetch` rejects with the opaque message "fetch failed" and puts
// the real errno (ETIMEDOUT, ENOTFOUND, ECONNREFUSED, CERT_HAS_EXPIRED, ...) on
// `error.cause`. Logging `.message` alone therefore emits lines like "provider
// verification fetch threw: fetch failed" — naming the call site and nothing
// else, which cannot distinguish "their outage" from "our DNS" from "our TLS"
// during an incident. Unwrapping here rather than at each catch site means every
// existing caller gains the errno without changing.

// Node system errors carry the errno on `code`. It is the single most actionable
// token in the line, so it is surfaced ahead of the message.
interface ErrorWithCode {
  code?: unknown;
}

// Chains are shallow in practice (undici nests one level). The cap bounds a
// pathological or self-referential chain; `visited` covers the cyclic case that
// a depth limit alone would only truncate rather than detect.
const MAX_CAUSE_DEPTH = 4;

function describeCause(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const { code } = cause as ErrorWithCode;
  return typeof code === 'string' ? `${code}: ${cause.message}` : cause.message;
}

function collectCauseChain(error: unknown): string[] {
  const descriptions: string[] = [];
  const visited = new Set<unknown>();
  let currentCause: unknown = error instanceof Error ? error.cause : undefined;

  while (
    currentCause !== undefined &&
    currentCause !== null &&
    descriptions.length < MAX_CAUSE_DEPTH
  ) {
    if (visited.has(currentCause)) break;
    visited.add(currentCause);
    descriptions.push(describeCause(currentCause));
    currentCause =
      currentCause instanceof Error ? currentCause.cause : undefined;
  }

  return descriptions;
}

export function formatErrorMessage(error: unknown): string {
  const primaryMessage = error instanceof Error ? error.message : String(error);
  const causeChain = collectCauseChain(error);
  return causeChain.length === 0
    ? primaryMessage
    : `${primaryMessage} (cause: ${causeChain.join(' <- ')})`;
}
