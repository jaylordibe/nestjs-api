import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AppPlatform } from '../../../common/enums/app-platform.enum';

export class CreateAppVersionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  version!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsEnum(AppPlatform)
  platform!: AppPlatform;

  @Type(() => Date)
  @IsDate()
  releaseDate!: Date;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  downloadUrl?: string;

  @IsOptional()
  @IsBoolean()
  forceUpdate?: boolean;
}
