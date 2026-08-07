import { IsString, MaxLength, MinLength } from 'class-validator';

export class RefreshTokenDto {
  /**
   * The refresh token issued by `POST /auth/login` or a previous
   * `POST /auth/refresh`.
   *
   * Bounded on both sides so a malformed or hostile body is rejected by the
   * validation pipe before it reaches a database lookup. The generated token is
   * 32 random bytes in base64url — 43 characters — so the window is generous
   * enough to survive a future change of token length without being an open
   * door for megabyte-sized payloads.
   */
  @IsString()
  @MinLength(20)
  @MaxLength(512)
  refreshToken!: string;
}
