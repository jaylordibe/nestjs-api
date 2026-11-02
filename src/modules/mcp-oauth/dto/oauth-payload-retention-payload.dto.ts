import { BaseJobPayloadDto } from '../../../common/queue/dto/base-job-payload.dto';

// The sweep acts on no single row, so it adds nothing to the base payload; a
// named type still makes an unexpected field a permanent failure (see
// RefreshTokenRetentionPayloadDto).
export class OAuthPayloadRetentionPayloadDto extends BaseJobPayloadDto {}
