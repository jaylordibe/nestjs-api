import { IsString, MaxLength, MinLength } from 'class-validator';
import { IsCheckedPassword } from '../../../common/decorators/is-checked-password.decorator';

export class LoginDto {
  // Email address OR username — both are accepted. Usernames can never
  // contain '@' (enforced by CreateUserDto's pattern), so the two namespaces
  // can't collide. Matched case-insensitively (both are stored lowercase).
  @IsString()
  @MinLength(3)
  @MaxLength(254)
  identifier!: string;

  @IsCheckedPassword()
  password!: string;
}
