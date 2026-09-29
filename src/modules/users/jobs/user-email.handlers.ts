import { Injectable } from '@nestjs/common';
import { JobName } from '../../../common/queue/job-registry';
import {
  RegisterQueueJobHandler,
  type QueueJobHandler,
} from '../../../common/queue/queue-job-handler';
import {
  completedJob,
  skippedJob,
  type JobOutcome,
} from '../../../common/queue/queue-job-outcome';
import { UsersService } from '../users.service';
import {
  PasswordChangedNoticePayloadDto,
  UserEmailJobPayloadDto,
} from './user-email-job-payload.dto';

// Thin adapters from the queue to UsersService. A provider failure throws and
// is retried under the queue's policy.

@Injectable()
@RegisterQueueJobHandler()
export class EmailVerificationJobHandler implements QueueJobHandler<UserEmailJobPayloadDto> {
  readonly jobName = JobName.USER_EMAIL_VERIFICATION_V1;
  readonly payloadType = UserEmailJobPayloadDto;

  constructor(private readonly usersService: UsersService) {}

  async handle(payload: UserEmailJobPayloadDto): Promise<JobOutcome> {
    return (await this.usersService.deliverEmailVerification(payload.userId))
      ? completedJob()
      : skippedJob('account gone or already verified');
  }
}

@Injectable()
@RegisterQueueJobHandler()
export class PasswordResetJobHandler implements QueueJobHandler<UserEmailJobPayloadDto> {
  readonly jobName = JobName.USER_PASSWORD_RESET_V1;
  readonly payloadType = UserEmailJobPayloadDto;

  constructor(private readonly usersService: UsersService) {}

  async handle(payload: UserEmailJobPayloadDto): Promise<JobOutcome> {
    return (await this.usersService.deliverPasswordReset(payload.userId))
      ? completedJob()
      : skippedJob('account gone or inactive');
  }
}

@Injectable()
@RegisterQueueJobHandler()
export class PasswordChangedNoticeJobHandler implements QueueJobHandler<PasswordChangedNoticePayloadDto> {
  readonly jobName = JobName.USER_PASSWORD_CHANGED_NOTICE_V1;
  readonly payloadType = PasswordChangedNoticePayloadDto;

  constructor(private readonly usersService: UsersService) {}

  async handle(payload: PasswordChangedNoticePayloadDto): Promise<JobOutcome> {
    return (await this.usersService.deliverPasswordChangedNotice(
      payload.userId,
      new Date(payload.occurredAt),
    ))
      ? completedJob()
      : skippedJob('account gone');
  }
}
