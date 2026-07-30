import { ApiHideProperty } from '@nestjs/swagger';
import { Exclude } from 'class-transformer';
import { AppVersion } from '@prisma/client';
import { AppPlatform } from '../../../common/enums/app-platform.enum';
import { DeviceOs } from '../../../common/enums/device-os.enum';

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
  // The release train this row describes: `ios`/`android` for mobile,
  // `macos`/`windows`/`linux` for desktop. Null for `web`, which has a single
  // distribution.
  deviceOs!: DeviceOs | null;
  releaseDate!: Date;
  downloadUrl!: string | null;
  forceUpdate!: boolean;

  constructor(row: AppVersion) {
    Object.assign(this, row);
  }
}
