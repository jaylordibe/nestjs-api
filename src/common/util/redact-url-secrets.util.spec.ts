import {
  redactQueryParameters,
  redactUrlSecrets,
} from './redact-url-secrets.util';

describe('redactUrlSecrets', () => {
  // The concrete leak this exists for: the email-verification link carries a
  // bearer token in the query string, and following that link is precisely
  // what produces the log line.
  it('redacts the email-verification token', () => {
    expect(
      redactUrlSecrets(
        '/api/auth/verify-email?token=eyJhbGciOiJIUzI1NiJ9.payload.signature',
      ),
    ).toBe('/api/auth/verify-email?token=[redacted]');
  });

  it('leaves a URL with no query string untouched', () => {
    expect(redactUrlSecrets('/api/users/me')).toBe('/api/users/me');
  });

  // An access log that cannot tell you which endpoint was called is not worth
  // keeping, so the path and the harmless parameters must survive.
  it('preserves the path and non-secret parameters', () => {
    expect(
      redactUrlSecrets('/api/users?page=2&perPage=50&token=abc&sortBy=email'),
    ).toBe('/api/users?page=2&perPage=50&token=[redacted]&sortBy=email');
  });

  it('matches parameter names case-insensitively', () => {
    expect(redactUrlSecrets('/api/callback?Token=abc&CODE=xyz')).toBe(
      '/api/callback?Token=[redacted]&CODE=[redacted]',
    );
  });

  // A signed storage URL's signature IS the permission — logging one hands
  // whoever reads the log the same access the URL grants.
  describe('signed object-storage URLs', () => {
    it('redacts an AWS SigV4 presigned URL', () => {
      const redacted = redactUrlSecrets(
        '/uploads/a.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20260812&X-Amz-Signature=deadbeef',
      );

      expect(redacted).not.toContain('deadbeef');
      expect(redacted).not.toContain('AKIA');
      // The non-secret parameter stays, so the log still shows what happened.
      expect(redacted).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    });

    it('redacts a Google Cloud Storage V4 signed URL', () => {
      expect(
        redactUrlSecrets('/uploads/a.png?X-Goog-Signature=deadbeef'),
      ).not.toContain('deadbeef');
    });

    // The signature AND the grant's shape. `sig` is the credential; `sp`, `se`,
    // `st` and friends describe the permission set and validity window, which
    // disclose what the leaked-but-redacted grant would have allowed.
    it('redacts an Azure user-delegation SAS, signature and grant shape alike', () => {
      expect(redactUrlSecrets('/uploads/a.png?sp=r&sig=deadbeef')).toBe(
        '/uploads/a.png?sp=[redacted]&sig=[redacted]',
      );
    });
  });

  // Re-encoding would make the logged URL stop matching the request the client
  // actually sent, which is the property that makes an access log reproducible.
  it('does not re-encode the parameters it keeps', () => {
    expect(redactUrlSecrets('/api/search?q=a%20b%26c&token=x')).toBe(
      '/api/search?q=a%20b%26c&token=[redacted]',
    );
  });

  it('tolerates malformed query strings', () => {
    expect(redactUrlSecrets('/api/thing?&&flag&token=x')).toBe(
      '/api/thing?&&flag&token=[redacted]',
    );
  });

  it('redacts every occurrence of a repeated secret parameter', () => {
    expect(redactUrlSecrets('/api/x?token=a&token=b')).toBe(
      '/api/x?token=[redacted]&token=[redacted]',
    );
  });
});

describe('redactQueryParameters', () => {
  // Exists because redacting only the URL string looked like a fix while the
  // secret still shipped: a logger serializes the parsed query object too, and
  // that copy went out unredacted.
  it('redacts a secret parameter in the parsed query object', () => {
    expect(redactQueryParameters({ token: 'SUPERSECRET', page: '2' })).toEqual({
      token: '[redacted]',
      page: '2',
    });
  });

  it('matches names case-insensitively', () => {
    expect(redactQueryParameters({ Token: 'abc' })).toEqual({
      Token: '[redacted]',
    });
  });

  it('leaves a query with nothing sensitive untouched', () => {
    const query = { page: '2', perPage: '50', sortBy: 'email' };

    expect(redactQueryParameters(query)).toEqual(query);
  });

  it('handles an empty query', () => {
    expect(redactQueryParameters({})).toEqual({});
  });

  // Express parses repeated parameters into an array; the value shape must not
  // change what gets redacted.
  it('redacts a repeated parameter parsed as an array', () => {
    expect(redactQueryParameters({ token: ['a', 'b'] })).toEqual({
      token: '[redacted]',
    });
  });
});
