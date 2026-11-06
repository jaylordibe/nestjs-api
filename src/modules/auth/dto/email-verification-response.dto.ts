// Response for the JSON email-verification endpoint (`POST /auth/verify-email`):
// a single `isVerified` predicate the SPA asserts on. The GET sibling instead
// 302-redirects a browser to the web app's verification-result page.
// The shape of a plain object a handler returns — never constructed, so the
// fields are `declare`d (type and Swagger schema only, nothing emitted).
export class EmailVerificationResponseDto {
  declare isVerified: boolean;
}
