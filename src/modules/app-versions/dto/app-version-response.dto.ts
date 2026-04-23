import { AppVersion } from '@prisma/client';
import { AppPlatform } from '../../../common/enums/app-platform.enum';

export class AppVersionResponseDto {
  id!: string;
  createdAt!: Date;
  updatedAt!: Date;
  createdBy!: string | null;
  updatedBy!: string | null;
  version!: string;
  description!: string | null;
  platform!: AppPlatform;
  releaseDate!: Date;
  downloadUrl!: string | null;
  forceUpdate!: boolean;

  constructor(row: AppVersion) {
    Object.assign(this, row);
  }
}
