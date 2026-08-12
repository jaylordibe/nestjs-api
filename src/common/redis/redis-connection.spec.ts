import { buildRedisTransportOptions } from './redis-connection';

// Every Redis client in the app is built from this one function, so a defect
// here is a defect in the throttler, the queue and the shared client at once —
// and the two that matter most (silently unencrypted traffic, and TLS with
// verification disabled) both LOOK healthy from the outside.
describe('buildRedisTransportOptions', () => {
  const PLAIN_TLS_SETTINGS = {
    isEnabled: false,
    certificateAuthority: undefined,
  };

  // Any syntactically valid PEM body works: nothing here parses the
  // certificate, it is handed to Node's TLS stack at connect time.
  const CERTIFICATE_AUTHORITY_PEM = [
    '-----BEGIN CERTIFICATE-----',
    'MIIBteFakeCertificateBodyForUnitTestsOnly',
    '-----END CERTIFICATE-----',
  ].join('\n');

  describe('plain Redis', () => {
    it('builds host, port and logical database from the URL', () => {
      const options = buildRedisTransportOptions(
        'redis://localhost:6378/3',
        PLAIN_TLS_SETTINGS,
      );

      expect(options).toEqual({ host: 'localhost', port: 6378, db: 3 });
    });

    it('defaults the port and the logical database when the URL omits them', () => {
      const options = buildRedisTransportOptions(
        'redis://localhost',
        PLAIN_TLS_SETTINGS,
      );

      expect(options).toEqual({ host: 'localhost', port: 6379, db: 0 });
    });

    it('never sets a tls option, so ioredis dials plaintext', () => {
      const options = buildRedisTransportOptions(
        'redis://localhost:6379',
        PLAIN_TLS_SETTINGS,
      );

      expect(options.tls).toBeUndefined();
    });
  });

  describe('authenticated Redis', () => {
    it('carries the username and password through', () => {
      const options = buildRedisTransportOptions(
        'redis://default:s3cret-value@redis.internal:6379/1',
        PLAIN_TLS_SETTINGS,
      );

      expect(options).toEqual({
        host: 'redis.internal',
        port: 6379,
        username: 'default',
        password: 's3cret-value',
        db: 1,
      });
    });

    // Managed-Redis AUTH strings are generated, so a `/` or an `@` inside one is
    // ordinary rather than exotic — and an un-decoded password fails as a bare
    // "WRONGPASS", which reads as a wrong secret rather than a parsing bug.
    it('percent-decodes a password containing URL-significant characters', () => {
      const options = buildRedisTransportOptions(
        'redis://default:pa%2Fss%40word@redis.internal:6379',
        PLAIN_TLS_SETTINGS,
      );

      expect(options.password).toBe('pa/ss@word');
    });
  });

  describe('TLS Redis', () => {
    it('enables TLS with verification and no explicit CA when none is supplied', () => {
      const options = buildRedisTransportOptions(
        'rediss://default:secret@10.0.0.3:6378',
        { isEnabled: true, certificateAuthority: undefined },
      );

      expect(options.tls).toEqual({ rejectUnauthorized: true });
      expect(options.host).toBe('10.0.0.3');
    });

    it('passes the supplied CA through with verification still enabled', () => {
      const options = buildRedisTransportOptions('rediss://10.0.0.3:6378', {
        isEnabled: true,
        certificateAuthority: CERTIFICATE_AUTHORITY_PEM,
      });

      expect(options.tls).toEqual({
        ca: CERTIFICATE_AUTHORITY_PEM,
        rejectUnauthorized: true,
      });
    });

    // Secret Manager and `env_file` both flatten a PEM to one line, so the
    // newlines arrive as literal backslash-n. Node's TLS parser rejects that
    // with an opaque error a long way from the cause.
    it('restores newlines in a PEM that was flattened to a single line', () => {
      const options = buildRedisTransportOptions('rediss://10.0.0.3:6378', {
        isEnabled: true,
        certificateAuthority: CERTIFICATE_AUTHORITY_PEM.replace(/\n/g, '\\n'),
      });

      expect(options.tls).toEqual({
        ca: CERTIFICATE_AUTHORITY_PEM,
        rejectUnauthorized: true,
      });
    });

    // The one option this builder must never emit. It would keep the encryption
    // and discard the proof that the far end is the Redis that was meant, which
    // is the only reason in-transit encryption is worth configuring.
    it('never disables certificate verification', () => {
      const options = buildRedisTransportOptions('rediss://10.0.0.3:6378', {
        isEnabled: true,
        certificateAuthority: CERTIFICATE_AUTHORITY_PEM,
      });

      expect(
        (options.tls as { rejectUnauthorized: boolean }).rejectUnauthorized,
      ).toBe(true);
    });
  });

  describe('invalid configuration', () => {
    // The expensive failure: somebody believes traffic is encrypted and it is
    // not. Both spellings of the disagreement are refused rather than resolved.
    it('refuses TLS enabled against a plaintext redis:// URL', () => {
      expect(() =>
        buildRedisTransportOptions('redis://redis.internal:6379', {
          isEnabled: true,
          certificateAuthority: undefined,
        }),
      ).toThrow(/REDIS_TLS_ENABLED is true but REDIS_URL uses the plaintext/);
    });

    it('refuses a rediss:// URL with TLS disabled', () => {
      expect(() =>
        buildRedisTransportOptions(
          'rediss://redis.internal:6379',
          PLAIN_TLS_SETTINGS,
        ),
      ).toThrow(/REDIS_TLS_ENABLED is false/);
    });

    it('refuses a CA that is not a PEM certificate', () => {
      expect(() =>
        buildRedisTransportOptions('rediss://10.0.0.3:6378', {
          isEnabled: true,
          certificateAuthority: '/etc/ssl/certs/memorystore.pem',
        }),
      ).toThrow(/must be the PEM-encoded CA certificate/);
    });

    it('rejects a URL whose scheme is neither redis: nor rediss:', () => {
      expect(() =>
        buildRedisTransportOptions(
          'http://redis.internal:6379',
          PLAIN_TLS_SETTINGS,
        ),
      ).toThrow(/expected redis: or rediss:/);
    });

    it('rejects a non-numeric logical database segment', () => {
      expect(() =>
        buildRedisTransportOptions(
          'redis://redis.internal:6379/not-a-number',
          PLAIN_TLS_SETTINGS,
        ),
      ).toThrow(/Invalid Redis logical database index/);
    });

    // A malformed URL error is logged at boot, and `redis:` is a non-special
    // scheme — so a single missing slash puts the whole credential in the path
    // segment, which is exactly the string the error message quotes.
    it('redacts credentials from the error it raises', () => {
      expect(() =>
        buildRedisTransportOptions(
          'redis:/default:super-secret-password@redis.internal:6379',
          PLAIN_TLS_SETTINGS,
        ),
      ).toThrow(/\*\*\*@/);

      expect(() =>
        buildRedisTransportOptions(
          'redis:/default:super-secret-password@redis.internal:6379',
          PLAIN_TLS_SETTINGS,
        ),
      ).not.toThrow(/super-secret-password/);
    });
  });
});
