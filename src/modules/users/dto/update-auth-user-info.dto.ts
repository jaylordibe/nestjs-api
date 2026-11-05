import { PickType } from '@nestjs/swagger';
import { UpdateUserDto } from './update-user.dto';

// The profile picture is not here: it saves on its own, through
// `PUT`/`DELETE /users/me/profile-image`, so an unsaved profile form never
// holds back or loses a picture change.
export class UpdateAuthUserInfoDto extends PickType(UpdateUserDto, [
  'firstName',
  'middleName',
  'lastName',
  'phoneNumber',
  'gender',
  'birthday',
  'timezone',
] as const) {}
