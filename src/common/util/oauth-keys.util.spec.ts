import { createPublicKey, sign, verify } from 'node:crypto';
import { deriveOAuthServerKeys } from './oauth-keys.util';

describe('deriveOAuthServerKeys', () => {
  const secret = 'a-jwt-secret-of-reasonable-length-0123456789';

  it('is deterministic, so every instance of the API derives the same keys', () => {
    expect(deriveOAuthServerKeys(secret)).toEqual(
      deriveOAuthServerKeys(secret),
    );
  });

  it('derives different keys from a different secret', () => {
    const first = deriveOAuthServerKeys(secret);
    const second = deriveOAuthServerKeys(`${secret}-rotated`);
    expect(second.signingJwk.d).not.toBe(first.signingJwk.d);
    expect(second.signingJwk.kid).not.toBe(first.signingJwk.kid);
    expect(second.cookieKeys).not.toEqual(first.cookieKeys);
    expect(second.formTokenKey.equals(first.formTokenKey)).toBe(false);
  });

  it('keeps each derived key independent of the others and of the secret', () => {
    const keys = deriveOAuthServerKeys(secret);
    const values = [
      keys.signingJwk.d,
      keys.cookieKeys[0],
      keys.formTokenKey.toString('base64url'),
    ];
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) {
      expect(value).not.toContain(secret);
    }
  });

  it('produces a usable Ed25519 signing key', () => {
    const { signingJwk } = deriveOAuthServerKeys(secret);
    expect(signingJwk).toMatchObject({
      kty: 'OKP',
      crv: 'Ed25519',
      alg: 'EdDSA',
      use: 'sig',
    });
    const message = Buffer.from('payload');
    const publicJwk = {
      kty: signingJwk.kty,
      crv: signingJwk.crv,
      x: signingJwk.x,
    };
    const signature = sign(null, message, { key: signingJwk, format: 'jwk' });
    expect(
      verify(
        null,
        message,
        createPublicKey({ key: publicJwk, format: 'jwk' }),
        signature,
      ),
    ).toBe(true);
  });
});
