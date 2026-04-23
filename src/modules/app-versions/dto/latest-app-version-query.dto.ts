import { IsEnum } from 'class-validator';
import { AppPlatform } from '../../../common/enums/app-platform.enum';

export class LatestAppVersionQueryDto {
  @IsEnum(AppPlatform)
  platform!: AppPlatform;
}
