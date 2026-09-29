import { IsString, IsUUID } from 'class-validator';
import { BaseJobPayloadDto } from '../../../../common/queue/dto/base-job-payload.dto';

// The token rides in the payload because only its hash is stored; the worker
// reloads everything else from the invitation.
export class BusinessInvitationEmailJobPayloadDto extends BaseJobPayloadDto {
  @IsUUID()
  invitationId!: string;

  @IsString()
  token!: string;

  @IsUUID()
  inviterId!: string;
}
