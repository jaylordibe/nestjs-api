import { Injectable } from '@nestjs/common';
import { JobName } from '../../../common/queue/job-registry';
import {
  RegisterQueueJobHandler,
  type QueueJobHandler,
} from '../../../common/queue/queue-job-handler';
import type { JobOutcome } from '../../../common/queue/queue-job-outcome';
import { deliveryJobOutcome } from '../../../common/send-limit/delivery-outcome';
import { UsersService } from '../users.service';
import {
  EmailChangedNoticePayloadDto,
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
    return deliveryJobOutcome(
      await this.usersService.deliverEmailVerification(payload.userId),
      'account gone or already verified',
    );
  }
}

@Injectable()
@RegisterQueueJobHandler()
export class PasswordResetJobHandler implements QueueJobHandler<UserEmailJobPayloadDto> {
  readonly jobName = JobName.USER_PASSWORD_RESET_V1;
  readonly payloadType = UserEmailJobPayloadDto;

  constructor(private readonly usersService: UsersService) {}

  async handle(payload: UserEmailJobPayloadDto): Promise<JobOutcome> {
    return deliveryJobOutcome(
      await this.usersService.deliverPasswordReset(payload.userId),
      'account gone or inactive',
    );
  }
}

@Injectable()
@RegisterQueueJobHandler()
export class PasswordChangedNoticeJobHandler implements QueueJobHandler<PasswordChangedNoticePayloadDto> {
  readonly jobName = JobName.USER_PASSWORD_CHANGED_NOTICE_V1;
  readonly payloadType = PasswordChangedNoticePayloadDto;

  constructor(private readonly usersService: UsersService) {}

  async handle(payload: PasswordChangedNoticePayloadDto): Promise<JobOutcome> {
    return deliveryJobOutcome(
      await this.usersService.deliverPasswordChangedNotice(
        payload.userId,
        new Date(payload.occurredAt),
      ),
      'account gone',
    );
  }
}

@Injectable()
@RegisterQueueJobHandler()
export class EmailChangedNoticeJobHandler implements QueueJobHandler<EmailChangedNoticePayloadDto> {
  readonly jobName = JobName.USER_EMAIL_CHANGED_NOTICE_V1;
  readonly payloadType = EmailChangedNoticePayloadDto;

  constructor(private readonly usersService: UsersService) {}

  async handle(payload: EmailChangedNoticePayloadDto): Promise<JobOutcome> {
    return deliveryJobOutcome(
      await this.usersService.deliverEmailChangedNotice(
        payload.userId,
        payload.auditLogId,
      ),
      'account or audit record gone',
    );
  }
}
