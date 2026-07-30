import { IsEnum, ValidateIf } from 'class-validator';
import { AppPlatform } from '../../../common/enums/app-platform.enum';
import { DeviceOs } from '../../../common/enums/device-os.enum';
import { isSingleDistributionPlatform } from '../release-train-registry';

export class LatestAppVersionQueryDto {
  @IsEnum(AppPlatform)
  platform!: AppPlatform;

  // A client on a multi-train platform MUST say which OS it is, so it resolves
  // its own release train rather than being offered a build it cannot install.
  // `web` omits it and matches the null-OS row.
  //
  // Named `os` rather than `deviceOs` because this is the shape a client sends
  // at launch — `/latest?platform=mobile&os=ios` — short and unambiguous in a
  // query string.
  @ValidateIf(
    (query: LatestAppVersionQueryDto) =>
      query.platform === undefined ||
      !isSingleDistributionPlatform(query.platform),
  )
  @IsEnum(DeviceOs)
  os?: DeviceOs;
}
