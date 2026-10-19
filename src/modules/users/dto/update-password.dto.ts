import { IsAccountPassword } from '../../../common/decorators/is-account-password.decorator';

export class UpdatePasswordDto {
  @IsAccountPassword()
  newPassword!: string;
}
