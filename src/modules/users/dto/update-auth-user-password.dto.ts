import { IsAccountPassword } from '../../../common/decorators/is-account-password.decorator';
import { IsCheckedPassword } from '../../../common/decorators/is-checked-password.decorator';

export class UpdateAuthUserPasswordDto {
  @IsCheckedPassword()
  currentPassword!: string;

  @IsAccountPassword()
  newPassword!: string;
}
