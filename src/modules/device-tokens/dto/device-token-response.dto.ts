import { ApiHideProperty } from '@nestjs/swagger';
import { Exclude } from 'class-transformer';
import { DeviceToken } from '@prisma/client';
import { AppPlatform } from '../../../common/enums/app-platform.enum';
import { DeviceOs } from '../../../common/enums/device-os.enum';
import { DeviceType } from '../../../common/enums/device-type.enum';

export class DeviceTokenResponseDto {
  id!: string;
  createdAt!: Date;
  updatedAt!: Date;
  // Audit-trail columns hidden from frontend — see CLAUDE.md.
  @ApiHideProperty() @Exclude() createdBy!: string | null;
  @ApiHideProperty() @Exclude() updatedBy!: string | null;
  userId!: string;
  token!: string;
  appPlatform!: AppPlatform;
  deviceType!: DeviceType;
  deviceOs!: DeviceOs;
  deviceOsVersion!: string;

  constructor(row: DeviceToken) {
    Object.assign(this, row);
  }
}
