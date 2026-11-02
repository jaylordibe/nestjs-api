import { createHash } from 'node:crypto';
import {
  findMcpClientByToken,
  parseMcpAllowedOrigins,
  parseMcpClientCredentials,
} from './mcp-client-credentials.util';

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

describe('parseMcpClientCredentials', () => {
  const n8nDigest = sha256('n8n-token');
  const claudeDigest = sha256('claude-token');

  it('reads name:digest pairs, tolerating spaces and empty entries', () => {
    expect(
      parseMcpClientCredentials(
        ` n8n:${n8nDigest} , ,claude-code:${claudeDigest},`,
      ),
    ).toEqual([
      { name: 'n8n', tokenSha256: n8nDigest },
      { name: 'claude-code', tokenSha256: claudeDigest },
    ]);
  });

  it('treats an empty value as no clients (MCP off)', () => {
    expect(parseMcpClientCredentials('')).toEqual([]);
    expect(parseMcpClientCredentials(' , ')).toEqual([]);
  });

  it.each([
    ['a raw token instead of a digest', 'n8n:not-a-digest'],
    ['an uppercase digest', `n8n:${n8nDigest.toUpperCase()}`],
    ['a short digest', `n8n:${n8nDigest.slice(1)}`],
    ['a missing name', `:${n8nDigest}`],
    ['a name with spaces', `my client:${n8nDigest}`],
    ['an uppercase name', `N8N:${n8nDigest}`],
    ['a missing separator', n8nDigest],
    ['a repeated name', `n8n:${n8nDigest},n8n:${claudeDigest}`],
    ['a repeated digest', `n8n:${n8nDigest},other:${n8nDigest}`],
  ])('refuses %s', (_, raw) => {
    expect(parseMcpClientCredentials(raw)).toBeNull();
  });
});

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

describe('findMcpClientByToken', () => {
  const credentials = [
    { name: 'n8n', tokenSha256: sha256('n8n-token') },
    { name: 'claude-code', tokenSha256: sha256('claude-token') },
  ];

  it('finds the client whose digest matches', () => {
    expect(findMcpClientByToken('claude-token', credentials)?.name).toBe(
      'claude-code',
    );
    expect(findMcpClientByToken('n8n-token', credentials)?.name).toBe('n8n');
  });

  it('returns null for an unknown token, the digest itself, or no clients', () => {
    expect(findMcpClientByToken('guess', credentials)).toBeNull();
    expect(findMcpClientByToken(sha256('n8n-token'), credentials)).toBeNull();
    expect(findMcpClientByToken('n8n-token', [])).toBeNull();
  });
});
