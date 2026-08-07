import { createHash, randomBytes } from 'node:crypto';

// 256 bits of CSPRNG output. Long enough that guessing is not a threat model,
// so the store never needs a rate limit to stay safe against brute force.
const TOKEN_BYTES = 32;

/**
 * Mints an opaque bearer credential.
 *
 * base64url so the value survives URLs, headers, JSON, and query strings with
 * no escaping — an invitation link and an `Authorization` header can carry the
 * same token unchanged.
 *
 * The plaintext exists exactly once, at the moment of issue. Hand it to the
 * caller and forget it; persist only `hashOpaqueToken(token)`.
 */
export function generateOpaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * SHA-256, hex-encoded — what goes in the database.
 *
 * Deliberately NOT bcrypt or argon2, and the distinction matters: those exist
 * to make GUESSING slow, and the input here is 256 bits of randomness, so
 * there is no dictionary to frustrate. A deliberately slow digest on a
 * credential-verification path is not extra safety, it is a CPU-exhaustion
 * lever handed to unauthenticated callers.
 *
 * Hashing at rest is still required: a database disclosure must yield no
 * usable sessions and no redeemable invitations.
 */
export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
