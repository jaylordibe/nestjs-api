import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ResetPasswordDto {
  @IsEmail()
  email!: string;

  // The `token` query parameter from the reset link.
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  token!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(72)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message:
      'newPassword must be at least 12 characters and contain a letter and a digit',
  })
  newPassword!: string;
}
