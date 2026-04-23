import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class UpdateAuthUserPasswordDto {
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  currentPassword!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(72)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message:
      'newPassword must be at least 12 characters and contain a letter and a digit',
  })
  newPassword!: string;
}
