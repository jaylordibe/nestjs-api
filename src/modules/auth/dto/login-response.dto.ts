import { ApiProperty } from '@nestjs/swagger';
import { UserResponseDto } from '../../users/dto/user-response.dto';

// A session's token pair plus the user. Returned by `POST /auth/login`,
// `POST /auth/refresh`, and the credential changes that keep the caller signed
// in (`PATCH /users/me/password`, `PATCH /users/me/email`).
// The shape of a plain object a handler returns — never constructed, so the
// fields are `declare`d (type and Swagger schema only, nothing emitted).
export class LoginResponseDto {
  declare accessToken: string;
  // Send to `POST /auth/refresh` for a new pair. Single-use: rotated on every
  // exchange.
  declare refreshToken: string;
  @ApiProperty({
    description: 'Access-token lifetime in seconds.',
    example: 900,
  })
  declare expiresIn: number;
  declare user: UserResponseDto;
}
