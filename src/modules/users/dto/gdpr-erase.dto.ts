import { IsCheckedPassword } from '../../../common/decorators/is-checked-password.decorator';

export class GdprEraseDto {
  @IsCheckedPassword()
  currentPassword!: string;
}
