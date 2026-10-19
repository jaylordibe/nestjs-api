import { IsString, MaxLength, MinLength } from 'class-validator';
import { IsAccountPassword } from '../../../common/decorators/is-account-password.decorator';

export class UpdateAuthUserPasswordDto {
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  currentPassword!: string;

  @IsAccountPassword()
  newPassword!: string;
}
