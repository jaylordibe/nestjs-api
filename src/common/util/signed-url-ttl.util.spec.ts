import {
  MAXIMUM_SIGNED_URL_TTL_SECONDS,
  MINIMUM_SIGNED_URL_TTL_SECONDS,
  resolveSignedUrlTtlSeconds,
} from './signed-url-ttl.util';

const DEFAULT_TTL_SECONDS = 300;

// A signed URL cannot be revoked, so its lifetime is the whole security
// boundary. These bounds are the only thing standing between "a link that
// expires in five minutes" and "a permanent unauthenticated read grant nobody
// recorded".
describe('resolveSignedUrlTtlSeconds', () => {
  it('honours a request inside the bounds', () => {
    expect(resolveSignedUrlTtlSeconds(120, DEFAULT_TTL_SECONDS)).toBe(120);
  });

  it('falls back to the configured default when nothing is requested', () => {
    expect(resolveSignedUrlTtlSeconds(undefined, DEFAULT_TTL_SECONDS)).toBe(
      DEFAULT_TTL_SECONDS,
    );
  });

  it('caps an over-long request rather than honouring it', () => {
    expect(resolveSignedUrlTtlSeconds(86_400, DEFAULT_TTL_SECONDS)).toBe(
      MAXIMUM_SIGNED_URL_TTL_SECONDS,
    );
  });

  it('caps an over-long configured default too', () => {
    // The default is operator-supplied, so it is no more trusted than a call
    // site's argument.
    expect(resolveSignedUrlTtlSeconds(undefined, 999_999)).toBe(
      MAXIMUM_SIGNED_URL_TTL_SECONDS,
    );
  });

  it('raises a too-short request to the floor', () => {
    expect(resolveSignedUrlTtlSeconds(1, DEFAULT_TTL_SECONDS)).toBe(
      MINIMUM_SIGNED_URL_TTL_SECONDS,
    );
  });

  // Clamping beats throwing: a bounds mistake should shorten the URL, not fail
  // the download it was requested for.
  it('clamps instead of throwing', () => {
    expect(() =>
      resolveSignedUrlTtlSeconds(Number.MAX_SAFE_INTEGER, DEFAULT_TTL_SECONDS),
    ).not.toThrow();
  });

  describe('falls back to the default for a value carrying no usable intent', () => {
    it.each([
      ['zero', 0],
      ['negative', -60],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('%s', (_label, requested) => {
      expect(resolveSignedUrlTtlSeconds(requested, DEFAULT_TTL_SECONDS)).toBe(
        DEFAULT_TTL_SECONDS,
      );
    });
  });

  it('never returns a fractional second', () => {
    expect(resolveSignedUrlTtlSeconds(90.7, DEFAULT_TTL_SECONDS)).toBe(90);
  });
});
