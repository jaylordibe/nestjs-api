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

/**
 * Waits until a session cutoff is in the past, so a token minted next survives.
 *
 * The counterpart to {@link nextWholeSecond}, and the price of it. Rounding the
 * cutoff up sacrifices the whole second it lands in: every token whose `iat`
 * floors into that second is treated as older than the change. That is correct
 * for tokens issued BEFORE the change — it is the hole being closed — but a
 * brand-new login lands in the same second too, and would be handed an access
 * token that is already dead. "Change your password, then sign in, then get a
 * 401 on your first request" is a real and thoroughly confusing bug.
 *
 * So issuance waits out the remainder of that second. Bounded by construction:
 * the cutoff is at most one second ahead of the moment it was written, so this
 * sleeps for under 1s and only when a credential change happened in the very
 * same second as the sign-in. Every other call returns immediately.
 *
 * The alternative — signing the token with an `iat` forced past the cutoff —
 * looks cheaper and is wrong: it would also carry the token past the NEXT
 * revocation written in that same second, which is the exact failure the
 * rounding exists to prevent. Delaying is the only direction that does not trade
 * the guarantee away.
 */
export async function waitForSessionCutoff(
  cutoff: Date | null,
  now: Date = new Date(),
): Promise<void> {
  if (!cutoff) return;
  const remainingMs = cutoff.getTime() - now.getTime();
  if (remainingMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, remainingMs));
}
