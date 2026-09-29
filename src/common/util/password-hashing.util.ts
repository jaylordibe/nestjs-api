import * as bcrypt from 'bcrypt';

// THE cost factor for every password hash in the service.
//
// 12 rounds is ~250ms on current hardware — OWASP's Password Storage Cheat
// Sheet floor for bcrypt, and low enough that a legitimate login stays snappy.
// Raising it re-hashes nothing: existing hashes carry their own cost in the
// `$2b$<rounds>$` prefix and keep verifying.
export const BCRYPT_ROUNDS = 12;

// The single hashing entry point. Every persisted password goes through here
// so the cost factor can never drift between call sites.
export function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}
