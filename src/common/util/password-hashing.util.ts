import * as bcrypt from 'bcrypt';

// THE cost factor for every password hash in the service. Kept in one place
// because the anti-enumeration timing guarantees below actively depend on it:
// a branch that hashes at a different cost answers in a measurably different
// time, and a constant copy-pasted per module drifts the moment one copy is
// tuned.
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

// Spends the same CPU time a real password hash costs, then throws the result
// away.
//
// Public signup/login endpoints deliberately answer identically whether or not
// an account was created — but a branch that returns WITHOUT hashing answers
// ~250ms sooner, and that gap is a side channel handing an attacker exactly
// the fact the uniform response exists to withhold (OWASP WSTG-IDNT-04).
// Calling this on every early-return branch keeps the timing profile flat.
// Same idea as the dummy `bcrypt.compare` the login path uses for unknown
// identifiers, in the direction that matters for registration.
export async function burnPasswordHashingTime(
  plaintext: string,
): Promise<void> {
  await hashPassword(plaintext);
}
