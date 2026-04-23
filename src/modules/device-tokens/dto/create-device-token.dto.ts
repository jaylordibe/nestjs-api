import {
  IsEnum,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AppPlatform } from '../../../common/enums/app-platform.enum';
import { DeviceOs } from '../../../common/enums/device-os.enum';
import { DeviceType } from '../../../common/enums/device-type.enum';

export class CreateDeviceTokenDto {
  @IsUUID()
  userId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(512)
  token!: string;

  @IsEnum(AppPlatform)
  appPlatform!: AppPlatform;

  @IsEnum(DeviceType)
  deviceType!: DeviceType;

  @IsEnum(DeviceOs)
  deviceOs!: DeviceOs;

  @IsString()
  @MinLength(1)
  @MaxLength(50)
  deviceOsVersion!: string;
}
