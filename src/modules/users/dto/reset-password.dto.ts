import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { IsAccountPassword } from '../../../common/decorators/is-account-password.decorator';

export class ResetPasswordDto {
  @IsEmail()
  email!: string;

  // The `token` query parameter from the reset link.
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  token!: string;

  @IsAccountPassword()
  newPassword!: string;
}
