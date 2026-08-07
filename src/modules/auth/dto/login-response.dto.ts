import { UserResponseDto } from '../../users/dto/user-response.dto';

// Successful-authentication payload: a short-lived bearer access token, the
// long-lived refresh token that renews it, and the authenticated user. The
// single source of truth for the shape returned by `POST /auth/login` and
// `POST /auth/refresh` alike — the two deliberately agree, so a client has one
// response handler rather than two.
export class LoginResponseDto {
  accessToken: string;
  // Send to `POST /auth/refresh` to obtain a new pair. Rotated on every use:
  // the value returned here is single-use, and the previous one stops working
  // the moment this is issued. Store it as a credential, not as a cache entry.
  refreshToken: string;
  user: UserResponseDto;
}
