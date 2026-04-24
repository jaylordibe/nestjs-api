import { ApiHideProperty } from '@nestjs/swagger';
import { Exclude } from 'class-transformer';
import { AppVersion } from '@prisma/client';
import { AppPlatform } from '../../../common/enums/app-platform.enum';

export class AppVersionResponseDto {
  id!: string;
  createdAt!: Date;
  updatedAt!: Date;
  // Audit-trail columns hidden from frontend — see CLAUDE.md.
  @ApiHideProperty() @Exclude() createdBy!: string | null;
  @ApiHideProperty() @Exclude() updatedBy!: string | null;
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
