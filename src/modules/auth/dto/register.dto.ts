import { PickType } from '@nestjs/swagger';
import { CreateUserDto } from '../../users/dto/create-user.dto';

// Registration takes only the four minimum fields. Other profile data
// (username, phone, birthday, etc.) is filled in later via
// `PATCH /users/me`. Keeps the sign-up form short and the verification
// email flow unambiguous.
export class RegisterDto extends PickType(CreateUserDto, [
  'email',
  'password',
  'firstName',
  'lastName',
] as const) {}
