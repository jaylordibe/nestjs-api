import { PartialType } from '@nestjs/swagger';
import { CreateAppVersionDto } from './create-app-version.dto';

export class UpdateAppVersionDto extends PartialType(CreateAppVersionDto) {}
