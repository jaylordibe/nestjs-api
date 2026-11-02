import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * One MCP integration client (n8n, Claude Code, …) allowed to call `/api/mcp`.
 * Only the SHA-256 digest of its token is ever configured: the raw token is
 * generated once, handed to that client, and never stored by the API.
 */
export interface McpClientCredential {
  name: string;
  tokenSha256: string;
}

// A client name is a log-safe slug; a digest is SHA-256 in lowercase hex.
const ENTRY_PATTERN = /^([a-z0-9][a-z0-9._-]{0,63}):([0-9a-f]{64})$/;

/**
 * Parses `MCP_CLIENT_TOKENS` — `name:sha256hex` pairs separated by commas.
 * Returns `[]` for an empty value (MCP disabled) and `null` when any entry is
 * malformed or a name or digest repeats, so env validation refuses the value
 * instead of the API booting with fewer clients than the operator listed.
 */
export function parseMcpClientCredentials(
  raw: string,
): McpClientCredential[] | null {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const credentials: McpClientCredential[] = [];
  for (const entry of entries) {
    const [, name, tokenSha256] = ENTRY_PATTERN.exec(entry) ?? [];
    if (name === undefined || tokenSha256 === undefined) return null;
    credentials.push({ name, tokenSha256 });
  }
  const names = new Set(credentials.map((credential) => credential.name));
  const digests = new Set(
    credentials.map((credential) => credential.tokenSha256),
  );
  if (names.size !== credentials.length) return null;
  if (digests.size !== credentials.length) return null;
  return credentials;
}

/**
 * Parses `MCP_ALLOWED_ORIGINS` — exact browser origins (`https://host[:port]`)
 * separated by commas. Returns `null` when an entry is not a bare origin.
 */
export function parseMcpAllowedOrigins(raw: string): string[] | null {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const entry of entries) {
    if (!URL.canParse(entry) || new URL(entry).origin !== entry) return null;
  }
  return entries;
}

/**
 * The client whose token digest matches, or `null`. Every configured digest is
 * compared in constant time, and the loop never exits early, so response
 * timing reveals neither a partial match nor which entry matched.
 */
export function findMcpClientByToken(
  token: string,
  credentials: readonly McpClientCredential[],
): McpClientCredential | null {
  const presented = createHash('sha256').update(token, 'utf8').digest();
  let matched: McpClientCredential | null = null;
  for (const credential of credentials) {
    const expected = Buffer.from(credential.tokenSha256, 'hex');
    if (timingSafeEqual(presented, expected) && matched === null) {
      matched = credential;
    }
  }
  return matched;
}
