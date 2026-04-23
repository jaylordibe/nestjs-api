import { PickType } from '@nestjs/mapped-types';
import { CreateUserDto } from './create-user.dto';

export class UpdateAuthUsernameDto extends PickType(CreateUserDto, [
  'username',
] as const) {
  declare username: string;
}
