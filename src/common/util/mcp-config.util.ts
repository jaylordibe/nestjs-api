/**
 * Parsing and policy helpers for the MCP endpoint's configuration
 * (`MCP_ALLOWED_ORIGINS`, `MCP_OAUTH_REDIRECT_DOMAINS`). Pure, so env
 * validation, configuration and the OAuth registration check share one rule.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function isBareOrigin(entry: string): boolean {
  return URL.canParse(entry) && new URL(entry).origin === entry;
}

/**
 * Parses `MCP_ALLOWED_ORIGINS` — exact browser origins (`https://host[:port]`)
 * separated by commas. Returns `null` when an entry is not a bare origin.
 */
export function parseMcpAllowedOrigins(raw: string): string[] | null {
  const entries = splitList(raw);
  return entries.every(isBareOrigin) ? entries : null;
}

/**
 * Parses `MCP_OAUTH_REDIRECT_DOMAINS` — the https origins an MCP client may
 * register as its OAuth redirect (`https://claude.ai,https://n8n.example.com`).
 * Empty means any https origin. Returns `null` when an entry is not a bare
 * https origin; loopback redirects are always allowed and are not listed here.
 */
export function parseMcpRedirectOrigins(raw: string): string[] | null {
  const entries = splitList(raw);
  const valid = entries.every(
    (entry) => isBareOrigin(entry) && new URL(entry).protocol === 'https:',
  );
  return valid ? entries : null;
}

/**
 * Whether `uri` is a loopback redirect (`http://localhost`, `127.0.0.1` or
 * `[::1]`, any port) — what a native client such as Claude Code listens on
 * (RFC 8252 §7.3).
 */
export function isLoopbackRedirectUri(uri: string): boolean {
  if (!URL.canParse(uri)) return false;
  const url = new URL(uri);
  return (
    url.protocol === 'http:' &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    url.username === '' &&
    url.password === ''
  );
}

/**
 * Whether a client registering through the MCP OAuth server may use `uri` as
 * a redirect. The MCP authorization spec allows only loopback or https
 * redirects; `allowedOrigins` (from `MCP_OAUTH_REDIRECT_DOMAINS`) narrows the
 * https ones when non-empty. No fragment, no credentials in the URL.
 */
export function isPermittedMcpRedirectUri(
  uri: string,
  allowedOrigins: readonly string[],
): boolean {
  if (!URL.canParse(uri)) return false;
  const url = new URL(uri);
  if (url.hash !== '' || url.username !== '' || url.password !== '') {
    return false;
  }
  if (isLoopbackRedirectUri(uri)) return true;
  if (url.protocol !== 'https:') return false;
  return allowedOrigins.length === 0 || allowedOrigins.includes(url.origin);
}
