// Registration response: a message only. The user must verify their email and
// sign in before they have a session.
// The shape of a plain object a handler returns — never constructed, so the
// fields are `declare`d (type and Swagger schema only, nothing emitted).
export class RegisterResponseDto {
  declare message: string;
}
