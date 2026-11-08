/**
 * The one algorithm this service signs and accepts JWTs with. AuthModule signs
 * with it and verifies with it (`JwtModule` sign and verify options), and both
 * verifiers that do not go through those options — `JwtStrategy` (passport-jwt
 * reads only its own options) and `UserAwareThrottlerGuard` — pin it too.
 *
 * Pinned rather than inferred. jsonwebtoken@9 derives HS256/384/512 from a
 * string secret, so without this a token signed with the right secret under
 * another HMAC algorithm verifies, and swapping to an asymmetric key later
 * would silently widen the accepted set (HS/RS confusion).
 */
export const JWT_ALGORITHM = 'HS256';
