/**
 * Fixed values of the MCP OAuth authorization server. Paths are absolute from
 * the origin: they sit outside the `/api` prefix, because RFC 8414 and RFC 9728
 * put discovery documents at `/.well-known/...` on the issuer's origin, and
 * MCP clients look for them there.
 */

/** The one scope a token issued here carries: use of this server's MCP tools. */
export const MCP_OAUTH_SCOPE = 'mcp:use';

export const MCP_OAUTH_PATHS = {
  authorization: '/oauth/authorize',
  token: '/oauth/token',
  registration: '/oauth/register',
  jwks: '/oauth/jwks',
  interaction: '/oauth/interaction',
  // Where the provider itself serves its metadata; requests for the RFC 8414
  // document are forwarded here.
  providerDiscovery: '/.well-known/openid-configuration',
} as const;

// Bounds on one open registration, as laravel/mcp's registration applies.
export const MCP_OAUTH_REGISTRATION_LIMITS = {
  redirectUris: 10,
  redirectUriLength: 1024,
  clientNameLength: 255,
} as const;

/** Every path the Nest global `/api` prefix must leave alone. */
export const MCP_OAUTH_PREFIX_EXCLUSIONS = [
  'oauth/{*path}',
  '.well-known/oauth-authorization-server',
  '.well-known/oauth-protected-resource',
  '.well-known/oauth-protected-resource/{*path}',
];

// A sign-in that takes longer than this starts over; also the lifetime of the
// provider's browser session, which only ever carries one sign-in (the login
// prompt is required on every authorization).
export const MCP_OAUTH_INTERACTION_TTL_SECONDS = 10 * 60;

// OAuth 2.1 recommends a short code lifetime; the client redeems it at once.
export const MCP_OAUTH_AUTHORIZATION_CODE_TTL_SECONDS = 60;

// Per-IP budgets for the unauthenticated protocol endpoints. Registration is
// the tightest: every call writes a row.
export const MCP_OAUTH_THROTTLE = {
  registration: { limit: 10, ttl: 60_000 },
  protocol: { limit: 60, ttl: 60_000 },
  page: { limit: 30, ttl: 60_000 },
} as const;
