import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

// Unreserved URL characters (RFC 3986 §2.3) plus `-` and `_`. Deliberately
// narrow: a request id is echoed into a response header, written to structured
// logs, and persisted into `audit_logs.metadata` — three sinks where a value
// carrying newlines, quotes, or control characters is a log-injection primitive
// rather than a correlation aid.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._~-]{1,200}$/;

// 200 matches `BaseJobPayloadDto.correlationId`'s existing `@MaxLength(200)`, so
// an id that survives the HTTP boundary also survives being carried onto the
// queue. Without a cap, an unauthenticated caller could push ~16 KiB (Node's
// default max header size) into an audit row on every request.
//
// The property name is deliberately obscure: it is stashed on the raw request
// object, which is shared with every other middleware in the process.
const RESOLVED_REQUEST_ID = Symbol.for('nestjs-api.resolvedRequestId');

interface RequestWithResolvedId {
  [RESOLVED_REQUEST_ID]?: string;
}

/**
 * The request's correlation id, resolved exactly once.
 *
 * Both `nestjs-pino`'s `genReqId` and `nestjs-cls`'s `idGenerator` call this,
 * and the memoisation is what makes them agree. Previously each held its own
 * copy of "read the header, else `randomUUID()`" — which produced the SAME id
 * whenever a client supplied `X-Request-Id`, and TWO DIFFERENT ids whenever one
 * did not. Since almost no real client sends the header, the logs and
 * `audit_logs.metadata.request.requestId` disagreed on essentially all traffic,
 * while a passing test that always sent the header hid it.
 *
 * Memoising on the request object rather than ordering the two middlewares is
 * deliberate: middleware order is easy to change and impossible to assert, so
 * this holds regardless of which one runs first.
 *
 * A client-supplied value is accepted only if it is short and boring. Anything
 * else is replaced — not rejected — because a malformed correlation header is
 * never a reason to fail somebody's request.
 */
export function resolveRequestId(request: IncomingMessage): string {
  const carrier = request as IncomingMessage & RequestWithResolvedId;
  const alreadyResolved = carrier[RESOLVED_REQUEST_ID];
  if (alreadyResolved !== undefined) return alreadyResolved;

  const header = request.headers['x-request-id'];
  // A repeated header arrives as an array; take the first rather than joining,
  // so a second header cannot smuggle past the length cap.
  const candidate = Array.isArray(header) ? header[0] : header;
  const resolved =
    typeof candidate === 'string' && SAFE_REQUEST_ID.test(candidate)
      ? candidate
      : randomUUID();

  carrier[RESOLVED_REQUEST_ID] = resolved;
  return resolved;
}

// Exported for the spec, so the pattern and the cap are asserted rather than
// only described.
export const REQUEST_ID_PATTERN = SAFE_REQUEST_ID;
