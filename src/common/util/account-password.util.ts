// The one password rule: every account password, whoever sets it and however
// (sign-up, reset, change, an admin, the seeder), passes it. `@IsAccountPassword()`
// applies it to a DTO field; the seeder, which bypasses the validation pipe,
// calls `isAccountPassword` directly.
//
// The maximum is bcrypt's, and bcrypt counts BYTES: it silently ignores
// everything past byte 72 of the UTF-8 encoding. Counted in characters, a
// password of multi-byte characters (ñ, emoji) would be accepted and then
// stored with its tail — possibly its only letter or digit — cut off.
export const ACCOUNT_PASSWORD_MIN_LENGTH = 8;
export const ACCOUNT_PASSWORD_MAX_BYTES = 72;
export const ACCOUNT_PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).+$/;

export function accountPasswordMessage(field: string): string {
  return `${field} must be at least ${ACCOUNT_PASSWORD_MIN_LENGTH} characters and at most ${ACCOUNT_PASSWORD_MAX_BYTES} bytes, and contain a letter and a digit`;
}

export function isAccountPassword(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= ACCOUNT_PASSWORD_MIN_LENGTH &&
    Buffer.byteLength(value, 'utf8') <= ACCOUNT_PASSWORD_MAX_BYTES &&
    ACCOUNT_PASSWORD_PATTERN.test(value)
  );
}
