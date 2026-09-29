import { IsUUID } from 'class-validator';
import { BaseJobPayloadDto } from '../../../common/queue/dto/base-job-payload.dto';
import { IsUtcIsoString } from '../../../common/decorators/is-utc-iso-string.decorator';

// Identifiers only: the worker reloads the user, so no address or token is
// stored in Redis.
export class UserEmailJobPayloadDto extends BaseJobPayloadDto {
  @IsUUID()
  userId!: string;
}

export class PasswordChangedNoticePayloadDto extends UserEmailJobPayloadDto {
  @IsUtcIsoString()
  occurredAt!: string;
}
