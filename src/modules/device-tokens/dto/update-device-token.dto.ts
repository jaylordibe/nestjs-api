import { PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateDeviceTokenDto } from './create-device-token.dto';

export class UpdateDeviceTokenDto extends PartialType(CreateDeviceTokenDto) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
