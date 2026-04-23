import { PickType } from '@nestjs/mapped-types';
import { UpdateUserDto } from './update-user.dto';

export class UpdateAuthUserInfoDto extends PickType(UpdateUserDto, [
  'firstName',
  'middleName',
  'lastName',
  'phoneNumber',
  'gender',
  'birthday',
  'timezone',
] as const) {}
