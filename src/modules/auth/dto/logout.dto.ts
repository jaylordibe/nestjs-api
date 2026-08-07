import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class LogoutDto {
  /**
   * The refresh token held by this device, so the session chain is closed and
   * not just the access token.
   *
   * Optional, because logout must still succeed for a client that has already
   * discarded it (or never stored one). Omitting it revokes only the access
   * token this request arrived on — which leaves the refresh token able to mint
   * a new one, so clients SHOULD send it.
   */
  @IsOptional()
  @IsString()
  @MinLength(20)
  @MaxLength(512)
  refreshToken?: string;
}
