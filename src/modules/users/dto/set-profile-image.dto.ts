import { IsUUID } from 'class-validator';

export class SetProfileImageDto {
  /**
   * The picture, as the `id` returned by `POST /files` with
   * `purpose: profile_image`. It must be your own upload and not yet attached:
   * someone else's file, one uploaded for another purpose, or one the cleanup
   * job already removed is 404; a used, expired or released one is 409
   * `FILE_NOT_ATTACHABLE`. Either way, upload it again.
   * Sending the id of the current picture changes nothing. To remove the
   * picture, use `DELETE /users/me/profile-image`.
   */
  @IsUUID()
  fileId!: string;
}
