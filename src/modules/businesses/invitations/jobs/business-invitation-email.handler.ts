import { Injectable } from '@nestjs/common';
import { JobName } from '../../../../common/queue/job-registry';
import {
  RegisterQueueJobHandler,
  type QueueJobHandler,
} from '../../../../common/queue/queue-job-handler';
import {
  completedJob,
  skippedJob,
  type JobOutcome,
} from '../../../../common/queue/queue-job-outcome';
import { BusinessInvitationsService } from '../business-invitations.service';
import { BusinessInvitationEmailJobPayloadDto } from './business-invitation-email-job-payload.dto';

@Injectable()
@RegisterQueueJobHandler()
export class BusinessInvitationEmailJobHandler implements QueueJobHandler<BusinessInvitationEmailJobPayloadDto> {
  readonly jobName = JobName.BUSINESS_INVITATION_EMAIL_V1;
  readonly payloadType = BusinessInvitationEmailJobPayloadDto;

  constructor(
    private readonly businessInvitationsService: BusinessInvitationsService,
  ) {}

  async handle(
    payload: BusinessInvitationEmailJobPayloadDto,
  ): Promise<JobOutcome> {
    return (await this.businessInvitationsService.deliverInvitationEmail(
      payload.invitationId,
      payload.token,
      payload.inviterId,
    ))
      ? completedJob()
      : skippedJob('invitation no longer pending');
  }
}
