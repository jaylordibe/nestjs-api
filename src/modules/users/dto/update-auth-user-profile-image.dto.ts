import { IsUrl, MaxLength } from 'class-validator';

export class UpdateAuthUserProfileImageDto {
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  profileImageUrl!: string;
}
