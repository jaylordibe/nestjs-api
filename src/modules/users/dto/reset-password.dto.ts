import {
  IsEmail,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ResetPasswordDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(4, 12)
  otp!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(72)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message:
      'newPassword must be at least 12 characters and contain a letter and a digit',
  })
  newPassword!: string;
}
