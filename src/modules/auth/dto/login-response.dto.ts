import { ApiProperty } from '@nestjs/swagger';
import { UserResponseDto } from '../../users/dto/user-response.dto';

// A session's token pair plus the user. Returned by `POST /auth/login`,
// `POST /auth/refresh`, and the credential changes that keep the caller signed
// in (`PATCH /users/me/password`, `PATCH /users/me/email`).
export class LoginResponseDto {
  accessToken: string;
  // Send to `POST /auth/refresh` for a new pair. Single-use: rotated on every
  // exchange.
  refreshToken: string;
  @ApiProperty({
    description: 'Access-token lifetime in seconds.',
    example: 900,
  })
  expiresIn: number;
  user: UserResponseDto;
}
