import { BaseJobPayloadDto } from '../../../common/queue/dto/base-job-payload.dto';

// The cleanup sweep acts on no single row, so it adds nothing to the base
// payload. Its own class still matters: the processor validates against the
// handler's `payloadType` with `forbidNonWhitelisted`.
export class FileCleanupPayloadDto extends BaseJobPayloadDto {}
