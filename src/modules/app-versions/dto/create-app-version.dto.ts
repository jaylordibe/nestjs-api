import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { IsUtcIsoString } from '../../../common/decorators/is-utc-iso-string.decorator';
import { AppPlatform } from '../../../common/enums/app-platform.enum';
import { DeviceOs } from '../../../common/enums/device-os.enum';
import { isSingleDistributionPlatform } from '../release-train-registry';

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

  // Required for any platform that ships more than one independently versioned
  // build (mobile → iOS/Android, desktop → macOS/Windows/Linux); omitted for
  // `web`, which has a single distribution.
  //
  // `@IsEnum` only proves the value is SOME DeviceOs — it cannot know that
  // `windows` is nonsense on a mobile release, because that depends on a sibling
  // field. That pairing is checked in the service against the release-train
  // registry, which is also where `update` re-checks it after merging a partial
  // patch onto the stored row. One rule, one place.
  //
  // The `platform === undefined` arm keeps this required when platform itself
  // is missing, so an empty body reports BOTH problems rather than hiding this
  // one behind the next request.
  @ValidateIf(
    (dto: CreateAppVersionDto) =>
      dto.platform === undefined || !isSingleDistributionPlatform(dto.platform),
  )
  @IsEnum(DeviceOs)
  deviceOs?: DeviceOs;

  // The API stores and returns UTC only. Clients pick the release moment in
  // their own local zone and convert to a UTC instant at the boundary; a naive
  // or non-UTC-offset string is rejected. Prisma accepts the ISO string
  // directly for the DateTime column.
  //
  // NOT `@Type(() => Date) @IsDate()`: under `enableImplicitConversion` that
  // pair silently accepts a zoneless `2026-07-30T09:00:00` and resolves it
  // against the SERVER's clock, so one payload means different instants in dev
  // and prod.
  @IsUtcIsoString()
  releaseDate!: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  downloadUrl?: string;

  @IsOptional()
  @IsBoolean()
  forceUpdate?: boolean;
}
