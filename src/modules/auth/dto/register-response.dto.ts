// Registration response: intentionally just a message — no user object, no
// access token. Keeps the pre-verification surface minimal (nothing useful for
// an attacker probing whether an email is registered) and reinforces that the
// user must verify + log in before they have a session. The disposable-email
// silent-drop path returns the byte-identical shape so the two branches are
// indistinguishable to the caller.
export class RegisterResponseDto {
  message: string;
}
