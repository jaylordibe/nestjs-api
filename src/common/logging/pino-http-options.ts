import type { IncomingMessage, ServerResponse } from 'http';
import {
  redactQueryParameters,
  redactUrlSecrets,
} from '../util/redact-url-secrets.util';
import { resolveRequestId } from '../util/request-id.util';

// The pino-http configuration, extracted from `app.module.ts` so it can be
// EXERCISED rather than merely read.
//
// It lives in its own file because of the defect that produced it: the redact
// paths were written as `request.headers.authorization` / `response.headers…`,
// but pino-http logs the request under the key `req` and the response under
// `res`. Every path therefore matched nothing, and `Authorization` and `Cookie`
// headers were written to stdout in clear on every logged request — while the
// configuration, the repository documentation and a code comment all said they
// were redacted. Nothing failed, because inert redaction and working redaction
// look identical from inside the process.
//
// A control that cannot fail a test is a control nobody can trust. The spec
// beside this file drives these exact options through a real pino-http instance
// over a real request and asserts the secrets do not appear in the output, so
// the next prefix mistake fails `yarn test` instead of shipping.
export interface PinoHttpOptionsInput {
  readonly isProduction: boolean;
  readonly isTest: boolean;
}

// pino-http's request and response log fields. Their names are fixed by the
// logger's wire format, not chosen here — and getting them wrong is exactly the
// defect this module exists to prevent, so they are named constants used by
// both the serializer key and every redact path.
const PINO_REQUEST_KEY = 'req';
const PINO_RESPONSE_KEY = 'res';

// Header names carrying a credential. `redact` censors whole properties, so
// only headers (and never the URL) can be handled this way.
//
// Request BODIES are deliberately absent: pino-http does not serialize a body
// at all, so a `req.body.password` path would be inert in exactly the way the
// original `request.*` paths were. Leaving such a path in place would restore
// the appearance of a control that does nothing. If body logging is ever added,
// it needs its own redaction and its own test.
export function buildRedactPaths(): string[] {
  return [
    `${PINO_REQUEST_KEY}.headers.authorization`,
    `${PINO_REQUEST_KEY}.headers.cookie`,
    `${PINO_REQUEST_KEY}.headers["x-api-key"]`,
    `${PINO_REQUEST_KEY}.headers["proxy-authorization"]`,
    `${PINO_RESPONSE_KEY}.headers["set-cookie"]`,
  ];
}

// Rewrites the logged URL so a credential in the QUERY STRING does not reach
// stdout. `redact` cannot do this: it censors whole properties, and the token
// is a substring of `req.url` — censoring that property would erase the path
// too and take every access log with it.
//
// Load-bearing, not defensive: `GET /api/auth/verify-email?token=…` carries a
// bearer credential in the query string by design, and an email client
// following that link is exactly what produces the log line. Signed
// object-storage URLs have the same property.
export function redactLoggedRequest(loggedRequest: {
  url?: string;
  query?: Record<string, unknown>;
  raw?: { url?: string };
}): Record<string, unknown> {
  return {
    ...loggedRequest,
    url: loggedRequest.url
      ? redactUrlSecrets(loggedRequest.url)
      : loggedRequest.url,
    // BOTH representations, deliberately. pino-http serializes the raw `url`
    // string AND Express's parsed `query` object, so redacting one and not the
    // other reads as fixed while the secret still ships.
    query: loggedRequest.query
      ? redactQueryParameters(loggedRequest.query)
      : loggedRequest.query,
    // pino-http's default serializer exposes `raw`; blanking it stops the
    // unredacted URL reappearing under a different key.
    raw: undefined,
  };
}

export function buildPinoHttpOptions({
  isProduction,
  isTest,
}: PinoHttpOptionsInput): Record<string, unknown> {
  return {
    level: isTest ? 'silent' : isProduction ? 'info' : 'debug',
    transport:
      !isProduction && !isTest
        ? { target: 'pino-pretty', options: { singleLine: true } }
        : undefined,
    genReqId: (request: IncomingMessage, response: ServerResponse) => {
      // Shared with the CLS middleware in app.module.ts. Memoised per request,
      // so whichever of the two runs first decides the value and the other
      // agrees — the header echoed here, the `requestId` in the error envelope,
      // and `audit_logs.metadata.request.requestId` are then the same string by
      // construction rather than by coincidence.
      const id = resolveRequestId(request);
      response.setHeader('X-Request-Id', id);
      return id;
    },
    serializers: {
      [PINO_REQUEST_KEY]: redactLoggedRequest,
    },
    redact: {
      paths: buildRedactPaths(),
      censor: '[redacted]',
    },
  };
}
