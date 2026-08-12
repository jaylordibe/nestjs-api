// Strips secret-bearing query parameters from a URL before it is logged.
//
// Why this is needed at all: pino-http logs `req.url`, query string included,
// and this API deliberately has endpoints that carry a credential there.
// `GET /api/auth/verify-email?token=<jwt>` is the clearest — the token is a
// bearer credential that verifies an email address, and an email client
// following the link is exactly the flow that produces the log line. Signed
// object-storage URLs have the same shape: the signature IS the permission.
//
// `redact.paths` in the pino config cannot reach this. It censors OBJECT
// PROPERTIES, and the token here is a substring inside one — so the property is
// `req.url` and censoring it would erase the path too, taking every access log
// with it. Rewriting the value is the only option that keeps the log useful.
//
// Matched by parameter NAME rather than by trying to recognise a secret's
// shape. A denylist of names is checkable against the routes that exist; a
// heuristic over values is not.
const SECRET_QUERY_PARAMETER_NAMES = new Set([
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'code',
  'secret',
  'password',
  'otp',
  'apikey',
  'api_key',
  'key',
  'signature',
  'sig',
  // AWS SigV4 presigned URLs.
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
  // Google Cloud Storage V4 signed URLs.
  'x-goog-signature',
  'x-goog-credential',
  // Azure user-delegation SAS. `sig` is the credential and is already listed
  // above; the rest identify the delegation window and permission set, which
  // disclose the grant's shape even once the signature is gone.
  'skoid',
  'sktid',
  'skt',
  'ske',
  'sp',
  'se',
  'st',
  'sr',
  'sv',
]);

const REDACTED_VALUE = '[redacted]';

// The parsed query object, redacted by the same rules as the raw URL.
//
// Needed as well as `redactUrlSecrets` because a logger may serialize BOTH: the
// raw `url` string and Express's parsed `query`. Redacting one and not the
// other reads as fixed while the secret still ships — which is exactly what
// happened here before this existed.
export function redactQueryParameters(
  query: Record<string, unknown>,
): Record<string, unknown> {
  const redactedQuery: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(query)) {
    redactedQuery[name] = SECRET_QUERY_PARAMETER_NAMES.has(name.toLowerCase())
      ? REDACTED_VALUE
      : value;
  }
  return redactedQuery;
}

export function redactUrlSecrets(url: string): string {
  const queryStringStart = url.indexOf('?');
  if (queryStringStart === -1) {
    return url;
  }

  const pathPortion = url.slice(0, queryStringStart);
  const queryPortion = url.slice(queryStringStart + 1);

  // Hand-split rather than parsed with URLSearchParams, which would re-encode
  // every other parameter and make the logged URL stop matching the one the
  // client actually sent — the property that makes an access log useful for
  // reproducing a request.
  const redactedQuery = queryPortion
    .split('&')
    .map((parameter) => {
      const separatorIndex = parameter.indexOf('=');
      if (separatorIndex === -1) {
        return parameter;
      }
      const name = parameter.slice(0, separatorIndex);
      return SECRET_QUERY_PARAMETER_NAMES.has(name.toLowerCase())
        ? `${name}=${REDACTED_VALUE}`
        : parameter;
    })
    .join('&');

  return `${pathPortion}?${redactedQuery}`;
}
