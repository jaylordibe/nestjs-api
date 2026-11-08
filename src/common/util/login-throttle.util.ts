import { createHash } from 'node:crypto';
import { DEFAULT_IPV6_SUBNET_PREFIX, normalizeIp } from '@nestjs/throttler';

// The IPv6 prefix every throttle key folds an address to. AppModule passes it
// to the throttler module (the guard's own tracker) and `loginThrottleTracker`
// uses it, so the two keys can never fold the same address differently.
export const THROTTLE_IPV6_SUBNET_PREFIX = DEFAULT_IPV6_SUBNET_PREFIX;

/**
 * Throttle key for every password sign-in form: the lower-cased identifier
 * plus the client address, as Laravel's starter kits do, so one attacker
 * cannot lock a victim out from another address.
 *
 * The address goes through the library's own `normalizeIp`, which folds an
 * IPv6 address to its prefix (THROTTLE_IPV6_SUBNET_PREFIX) and unwraps
 * IPv4-mapped ones: a raw `request.ip` would give an IPv6 host a fresh bucket
 * for every address in its prefix.
 *
 * This key REPLACES the `default` throttler's per-address key on those
 * routes, so sign-in has no limit per address alone: one address may try a
 * password against many accounts, slowed only by the Turnstile check.
 */
export function loginThrottleTracker(request: {
  body?: unknown;
  ip?: string;
}): string {
  const body = request.body as { identifier?: unknown } | undefined;
  const identifier =
    typeof body?.identifier === 'string'
      ? body.identifier.trim().toLowerCase()
      : '';
  const address = request.ip
    ? normalizeIp(request.ip, THROTTLE_IPV6_SUBNET_PREFIX)
    : '';
  return `${identifier}|${address}`;
}

/**
 * Throttle key for every password sign-in form: the REST login and the MCP
 * OAuth sign-in page. The default key includes the controller and handler, so
 * each route would get its own 5-a-minute budget and an attacker alternating
 * them would get 10 guesses per identifier and IP. One shared key gives both
 * routes one budget.
 */
export function passwordSignInThrottleKey(
  _context: unknown,
  tracker: string,
  throttlerName: string,
): string {
  return createHash('sha256')
    .update(`password-sign-in-${throttlerName}-${tracker}`)
    .digest('hex');
}
