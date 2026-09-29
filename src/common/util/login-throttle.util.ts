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
