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
import { WorkspaceInvitationsService } from '../workspace-invitations.service';
import { WorkspaceInvitationEmailJobPayloadDto } from './workspace-invitation-email-job-payload.dto';

@Injectable()
@RegisterQueueJobHandler()
export class WorkspaceInvitationEmailJobHandler implements QueueJobHandler<WorkspaceInvitationEmailJobPayloadDto> {
  readonly jobName = JobName.WORKSPACE_INVITATION_EMAIL_V1;
  readonly payloadType = WorkspaceInvitationEmailJobPayloadDto;

  constructor(
    private readonly workspaceInvitationsService: WorkspaceInvitationsService,
  ) {}

  async handle(
    payload: WorkspaceInvitationEmailJobPayloadDto,
  ): Promise<JobOutcome> {
    return (await this.workspaceInvitationsService.deliverInvitationEmail(
      payload.invitationId,
      payload.token,
      payload.inviterId,
    ))
      ? completedJob()
      : skippedJob('invitation no longer pending');
  }
}
