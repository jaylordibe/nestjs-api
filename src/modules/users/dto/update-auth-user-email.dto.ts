import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateAuthUserEmailDto {
  @IsEmail()
  newEmail!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  currentPassword!: string;
}
