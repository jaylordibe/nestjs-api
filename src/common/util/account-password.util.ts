// The one password rule: every account password, whoever sets it and however
// (sign-up, reset, change, an admin, the seeder), passes it. `@IsAccountPassword()`
// applies it to a DTO field; the seeder, which bypasses the validation pipe,
// calls `isAccountPassword` directly.
//
// The maximum is bcrypt's: it silently ignores everything past 72 bytes.
export const ACCOUNT_PASSWORD_MIN_LENGTH = 8;
export const ACCOUNT_PASSWORD_MAX_LENGTH = 72;
export const ACCOUNT_PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).+$/;

export function accountPasswordMessage(field: string): string {
  return `${field} must be ${ACCOUNT_PASSWORD_MIN_LENGTH}–${ACCOUNT_PASSWORD_MAX_LENGTH} characters and contain a letter and a digit`;
}

export function isAccountPassword(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= ACCOUNT_PASSWORD_MIN_LENGTH &&
    value.length <= ACCOUNT_PASSWORD_MAX_LENGTH &&
    ACCOUNT_PASSWORD_PATTERN.test(value)
  );
}
