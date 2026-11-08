import { createHash } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import {
  DEFAULT_IPV6_SUBNET_PREFIX,
  normalizeIp,
  type ThrottlerOptions,
} from '@nestjs/throttler';

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
 * routes, so the per-address limit is a throttler of its own:
 * `signInAddressThrottler`. `@ThrottleSignIn()` applies both.
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

/** The named throttler that limits password sign-in per address alone. */
export const SIGN_IN_ADDRESS_THROTTLER = 'sign-in-address';

/** Route metadata `@ThrottleSignIn()` sets; the address throttler counts only these. */
export const IS_SIGN_IN_ATTEMPT_KEY = 'isSignInAttempt';

/**
 * Password sign-in attempts per address, across every identifier and both
 * sign-in forms: 30 a minute. The per-identifier key stops one account being
 * guessed at; this stops one address trying a password against many accounts
 * (password spraying), which that key alone never limits. 30 leaves room for
 * many people signing in behind one shared address (an office, a carrier NAT).
 *
 * Keyed by the guard's own tracker — `ip:<address>`, IPv6 folded to its /64 —
 * and by `passwordSignInThrottleKey`, so both sign-in forms share one budget.
 * It counts only a route marked `@ThrottleSignIn()`; every other route skips
 * it and gets none of its headers.
 *
 * The address is `request.ip`, so this is only right when every hop in front
 * of the API is trusted (`TRUST_PROXY`, "Client topologies" in
 * docs/deployment/README.md). Behind an untrusted server-rendered web server,
 * every visitor would share that server's one budget.
 */
export function signInAddressThrottler(isTest: boolean): ThrottlerOptions {
  return {
    name: SIGN_IN_ADDRESS_THROTTLER,
    limit: 30,
    ttl: 60_000,
    generateKey: passwordSignInThrottleKey,
    // A named throttler's own skipIf REPLACES the module-wide one, so the
    // test-run skip is repeated here.
    skipIf: (context: ExecutionContext) => isTest || !isSignInAttempt(context),
  };
}

function isSignInAttempt(context: ExecutionContext): boolean {
  return (
    Reflect.getMetadata(IS_SIGN_IN_ATTEMPT_KEY, context.getHandler()) === true
  );
}
