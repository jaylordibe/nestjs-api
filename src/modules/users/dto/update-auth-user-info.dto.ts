import { PickType } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { UpdateUserDto } from './update-user.dto';

export class UpdateAuthUserInfoDto extends PickType(UpdateUserDto, [
  'firstName',
  'middleName',
  'lastName',
  'phoneNumber',
  'gender',
  'birthday',
  'timezone',
] as const) {
  /**
   * The profile picture, as the `id` returned by `POST /files` with
   * `purpose: profile_image`. Omit to leave it unchanged, send `null` to remove
   * it, send an id to set or replace it. The file must be your own upload and
   * not yet attached; re-sending the id of the current picture changes nothing.
   */
  @IsOptional()
  @IsUUID()
  profileImageFileId?: string | null;
}
