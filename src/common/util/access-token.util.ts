/**
 * Whether a verified JWT payload is an access token.
 *
 * Access tokens never set `purpose`; tokens signed for other flows (email
 * verification, future one-shot actions) always do, with the same secret,
 * issuer and audience. JwtStrategy refuses to authenticate anything else, and
 * UserAwareThrottlerGuard refuses to give anything else a per-user bucket.
 */
export function isAccessTokenPayload(payload: { purpose?: unknown }): boolean {
  return payload.purpose === undefined;
}
