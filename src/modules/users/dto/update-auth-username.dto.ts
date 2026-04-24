import { PickType } from '@nestjs/swagger';
import { CreateUserDto } from './create-user.dto';

export class UpdateAuthUsernameDto extends PickType(CreateUserDto, [
  'username',
] as const) {
  declare username: string;
}
