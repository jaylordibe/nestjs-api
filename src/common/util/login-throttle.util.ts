import { createHash } from 'node:crypto';

/**
 * Throttle key for `POST /auth/login`: the lower-cased identifier plus the
 * client IP, as Laravel's starter kits do. One attacker cannot lock a victim
 * out from another address, and one address cannot spray many accounts faster
 * than the per-IP global limit allows.
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
  return `${identifier}|${request.ip ?? ''}`;
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
