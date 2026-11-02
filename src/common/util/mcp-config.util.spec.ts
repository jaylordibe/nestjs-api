import {
  isLoopbackRedirectUri,
  isPermittedMcpRedirectUri,
  parseMcpAllowedOrigins,
  parseMcpRedirectOrigins,
} from './mcp-config.util';

describe('parseMcpAllowedOrigins', () => {
  it('reads exact origins', () => {
    expect(
      parseMcpAllowedOrigins('https://a.example.com, http://localhost:6274'),
    ).toEqual(['https://a.example.com', 'http://localhost:6274']);
    expect(parseMcpAllowedOrigins('')).toEqual([]);
  });

  it.each([
    ['a path', 'https://a.example.com/app'],
    ['a trailing slash', 'https://a.example.com/'],
    ['a wildcard', '*'],
    ['a bare host', 'a.example.com'],
  ])('refuses %s', (_, raw) => {
    expect(parseMcpAllowedOrigins(raw)).toBeNull();
  });
});

describe('parseMcpRedirectOrigins', () => {
  it('reads https origins, empty meaning any', () => {
    expect(
      parseMcpRedirectOrigins('https://claude.ai, ,https://n8n.example.com'),
    ).toEqual(['https://claude.ai', 'https://n8n.example.com']);
    expect(parseMcpRedirectOrigins('')).toEqual([]);
  });

  it.each([
    ['plain http', 'http://n8n.example.com'],
    ['a path', 'https://claude.ai/api'],
    ['a wildcard', '*'],
    ['a bare host', 'claude.ai'],
  ])('refuses %s', (_, raw) => {
    expect(parseMcpRedirectOrigins(raw)).toBeNull();
  });
});

describe('isLoopbackRedirectUri', () => {
  it.each([
    'http://localhost:3118/callback',
    'http://127.0.0.1/callback',
    'http://[::1]:9000/cb',
  ])('accepts %s', (uri) => {
    expect(isLoopbackRedirectUri(uri)).toBe(true);
  });

  it.each([
    'https://localhost/callback',
    'http://localhost.evil.example/callback',
    'http://user:pass@localhost/callback',
    'not a url',
  ])('refuses %s', (uri) => {
    expect(isLoopbackRedirectUri(uri)).toBe(false);
  });
});

describe('isPermittedMcpRedirectUri', () => {
  it('allows loopback and any https origin when no allowlist is set', () => {
    expect(
      isPermittedMcpRedirectUri('http://localhost:3118/callback', []),
    ).toBe(true);
    expect(
      isPermittedMcpRedirectUri('https://claude.ai/api/mcp/auth_callback', []),
    ).toBe(true);
  });

  it('narrows https redirects to the allowlist, never loopback', () => {
    const allowed = ['https://claude.ai'];
    expect(
      isPermittedMcpRedirectUri(
        'https://claude.ai/api/mcp/auth_callback',
        allowed,
      ),
    ).toBe(true);
    expect(
      isPermittedMcpRedirectUri('https://evil.example/callback', allowed),
    ).toBe(false);
    expect(isPermittedMcpRedirectUri('http://127.0.0.1/cb', allowed)).toBe(
      true,
    );
  });

  it.each([
    ['plain http to a public host', 'http://n8n.example.com/callback'],
    ['a custom scheme', 'cursor://callback'],
    ['a fragment', 'https://claude.ai/cb#frag'],
    ['credentials', 'https://user:pass@claude.ai/cb'],
    ['an unparseable value', 'claude.ai/cb'],
  ])('refuses %s', (_, uri) => {
    expect(isPermittedMcpRedirectUri(uri, [])).toBe(false);
  });
});
