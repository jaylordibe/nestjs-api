import { DeviceToken } from '@prisma/client';
import { AppPlatform } from '../../../common/enums/app-platform.enum';
import { DeviceOs } from '../../../common/enums/device-os.enum';
import { DeviceType } from '../../../common/enums/device-type.enum';

export class DeviceTokenResponseDto {
  id!: string;
  createdAt!: Date;
  updatedAt!: Date;
  createdBy!: string | null;
  updatedBy!: string | null;
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
