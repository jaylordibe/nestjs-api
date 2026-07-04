// Response for the JSON email-verification endpoint (`POST /auth/verify-email`):
// a single `verified` predicate the SPA asserts on. The GET sibling instead
// 302-redirects a browser to the web app's verification-result page.
export class EmailVerificationResponseDto {
  verified: boolean;
}
