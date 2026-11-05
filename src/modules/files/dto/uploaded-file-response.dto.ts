import { ApiProperty } from '@nestjs/swagger';
import type { FileAsset } from '@prisma/client';
import { FileAssetStatus } from '../../../common/enums/file-asset-status.enum';
import { FileKind } from '../../../common/enums/file-kind.enum';
import { FilePurpose } from '../../../common/enums/file-purpose.enum';

/**
 * A file just uploaded. Reference `id` in a JSON request to attach it, before
 * `expiresAt`.
 */
export class UploadedFileResponseDto {
  /** Send this id to attach the file (e.g. `fileId` on `PUT /users/me/profile-image`). */
  id!: string;
  @ApiProperty({ enum: FilePurpose })
  purpose!: FilePurpose;
  /** Always `ready` in the response to `POST /files`. */
  @ApiProperty({ enum: FileAssetStatus })
  status!: FileAssetStatus;
  /** `image`: re-encoded by the server, metadata removed. `document`: stored as uploaded. */
  @ApiProperty({ enum: FileKind })
  kind!: FileKind;
  /** The type the server identified from the file's content. */
  contentType!: string;
  /** Size of the stored file, after processing. */
  sizeBytes!: number | null;
  width!: number | null;
  height!: number | null;
  /** The uploaded name, made safe for display; its extension matches the content. */
  fileName!: string;
  /** The file can be attached until this moment; afterwards it is deleted. */
  expiresAt!: Date | null;

  // Built field by field rather than with `Object.assign(this, row)`: the row
  // carries `storageKey`, which the API never returns.
  constructor(row: FileAsset) {
    this.id = row.id;
    this.purpose = row.purpose as FilePurpose;
    this.status = row.status as FileAssetStatus;
    this.kind = row.kind as FileKind;
    this.contentType = row.contentType;
    this.sizeBytes = row.sizeBytes;
    this.width = row.width;
    this.height = row.height;
    this.fileName = row.fileName;
    this.expiresAt = row.expiresAt;
  }
}
