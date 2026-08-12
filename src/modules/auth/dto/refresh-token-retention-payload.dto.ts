import { BaseJobPayloadDto } from '../../../common/queue/dto/base-job-payload.dto';

// The retention sweep acts on no single row — it deletes every refresh token
// past its expiry — so it adds nothing to the base payload.
//
// It still gets its own class rather than reusing BaseJobPayloadDto directly:
// the processor validates against `handler.payloadType` with
// `forbidNonWhitelisted`, so a named type per job is what makes an unexpected
// field a permanent failure instead of silently ignored data.
export class RefreshTokenRetentionPayloadDto extends BaseJobPayloadDto {}
