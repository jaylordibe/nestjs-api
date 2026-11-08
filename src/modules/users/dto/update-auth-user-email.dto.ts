import { IsEmail } from 'class-validator';
import { IsCheckedPassword } from '../../../common/decorators/is-checked-password.decorator';

export class UpdateAuthUserEmailDto {
  @IsEmail()
  newEmail!: string;

  @IsCheckedPassword()
  currentPassword!: string;
}
