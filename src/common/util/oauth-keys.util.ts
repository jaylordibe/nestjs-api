import { createPrivateKey, hkdfSync, type JsonWebKey } from 'node:crypto';

/**
 * Keys the MCP OAuth authorization server needs, derived from one existing
 * secret (`JWT_SECRET`) so a fork gets them without a configuration edit.
 *
 * HKDF (RFC 5869) with a distinct `info` label per use gives keys that are
 * independent of each other and of the secret's own use: knowing one derived
 * key reveals neither the secret nor any other key. Rotating `JWT_SECRET`
 * rotates all of them (signed cookies, sign-in forms in progress). It does not
 * end issued MCP tokens: those are random values looked up by digest, ended by
 * the account's session cutoff or by deleting their `oauth_payloads` rows.
 *
 * Without an explicit `jwks`, oidc-provider falls back to development keys that
 * are published in its source — never acceptable outside a laptop.
 */
export interface OAuthServerKeys {
  /** Ed25519 private key, as the JWK oidc-provider's `jwks` option expects. */
  signingJwk: JsonWebKey & { kid: string; alg: string; use: string };
  /** HMAC keys for the provider's signed cookies (`cookies.keys`). */
  cookieKeys: string[];
  /** Key for the sign-in and consent forms' anti-forgery token. */
  formTokenKey: Buffer;
}

// DER prefix of a PKCS#8 Ed25519 private key; the 32-byte seed follows it.
const ED25519_PKCS8_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex',
);

function derive(secret: string, label: string, length: number): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.alloc(0),
      label,
      length,
    ),
  );
}

export function deriveOAuthServerKeys(secret: string): OAuthServerKeys {
  const seed = derive(secret, 'mcp-oauth/signing-key/v1', 32);
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const jwk = privateKey.export({ format: 'jwk' });
  // A key id that changes with the key, so a rotated secret never publishes
  // two different keys under one `kid`.
  const kid = derive(secret, 'mcp-oauth/signing-key-id/v1', 12).toString(
    'base64url',
  );
  return {
    signingJwk: { ...jwk, kid, alg: 'EdDSA', use: 'sig' },
    cookieKeys: [
      derive(secret, 'mcp-oauth/cookie-key/v1', 32).toString('base64url'),
    ],
    formTokenKey: derive(secret, 'mcp-oauth/form-token-key/v1', 32),
  };
}
