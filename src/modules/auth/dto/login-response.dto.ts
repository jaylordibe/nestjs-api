import { UserResponseDto } from '../../users/dto/user-response.dto';

// Successful-login payload: a bearer access token plus the authenticated user.
// The single source of truth for the login response shape — returned by
// `AuthService.login` and documented on `POST /auth/login`.
export class LoginResponseDto {
  accessToken: string;
  user: UserResponseDto;
}
