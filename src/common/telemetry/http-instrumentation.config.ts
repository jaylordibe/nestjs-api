import type { IncomingMessage } from 'node:http';
import { redactedIncomingUrlAttributes } from '../util/redact-url-secrets.util';

// Configuration for `@opentelemetry/instrumentation-http` (every request this
// API serves), kept here so it can be tested: `telemetry.ts` runs before the
// app and has no spec of its own.
//
// An incoming span records the query string, and some queries carry a
// credential (`/auth/verify-email?token=`) or something personal (search
// text). `startIncomingSpanHook`'s attributes replace the instrumentation's
// own `url.query` before the span starts, so nothing downstream sees the
// unredacted value.
//
// Imports only a pure function, so `telemetry.ts` can load it ahead of the SDK
// without leaving any patched module unpatched.
export const HTTP_INSTRUMENTATION_CONFIG = {
  // Health probes run every few seconds forever. Tracing them would dominate
  // the trace volume and tell you nothing you cannot read off the probe itself.
  ignoreIncomingRequestHook: (request: IncomingMessage) =>
    (request.url ?? '').startsWith('/api/health'),
  startIncomingSpanHook: (request: IncomingMessage) =>
    redactedIncomingUrlAttributes(request.url),
};
