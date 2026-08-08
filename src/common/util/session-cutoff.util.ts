/**
 * The instant from which previously-issued access tokens stop being valid.
 *
 * Rounded UP to the next whole second, and that is the entire point.
 *
 * A JWT's `iat` is whole seconds (RFC 7519 §4.1.6) while a timestamp column is
 * milliseconds, so a cutoff written as the raw current time leaves a sub-second
 * hole: a password change at 10.400s stores 10.400, the reader floors it to 10,
 * and a token minted at 10.100s carries `iat = 10` — not `< 10`, so it survives
 * the very control the account holder invoked to kill it. An attacker already
 * active on the account is exactly who lands in that window.
 *
 * Rounding up on the WRITE closes it without the side effect of rounding up on
 * the READ, which would reject a newly-registered user's first login whenever it
 * fell in the same second as their registration (account creation stamps this
 * column too).
 *
 * The cost is that a token minted in the same second as the change is treated as
 * older than it is, so the holder signs in again. That is the correct direction
 * to be wrong in.
 */
export function nextWholeSecond(from: Date = new Date()): Date {
  return new Date(Math.ceil(from.getTime() / 1000) * 1000);
}
