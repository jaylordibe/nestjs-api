import { PartialType } from '@nestjs/swagger';
import { CreateDeviceTokenDto } from './create-device-token.dto';

export class UpdateDeviceTokenDto extends PartialType(CreateDeviceTokenDto) {}
