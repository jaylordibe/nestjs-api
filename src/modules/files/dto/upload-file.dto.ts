import { IsEnum } from 'class-validator';
import { FilePurpose } from '../../../common/enums/file-purpose.enum';

/**
 * The non-file part of `POST /files`. The file itself is the multipart part
 * named `file`.
 */
export class UploadFileDto {
  /**
   * What the file is for. Decides which content is accepted, its size limit,
   * and where it can be attached: a `profile_image` file can only become a
   * profile image.
   */
  @IsEnum(FilePurpose)
  purpose!: FilePurpose;
}
