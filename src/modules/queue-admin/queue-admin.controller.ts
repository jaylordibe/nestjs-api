import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { AppAbility } from '../../common/authorization/app-ability';
import { CurrentAbility } from '../../common/decorators/current-ability.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { QueueName } from '../../common/queue/queue-registry';
import {
  QueueJobResponseDto,
  QueueSummaryDto,
} from './dto/queue-job-response.dto';
import { QueueAdminService } from './queue-admin.service';

/**
 * Background-job diagnostics for platform technical staff.
 *
 * Read is held by both PLATFORM_ENGINEER and PLATFORM_TECHNICAL_SUPPORT;
 * `readPayload` only by engineers, and `cancel` only by engineers. That split
 * is what "sanitized diagnostic visibility" means in practice — support can see
 * that a notification job failed and re-run it, without reading whose email it
 * was carrying.
 *
 * `ParseEnumPipe` on `:queue` is load-bearing beyond validation: it bounds the
 * value to a registered queue before it reaches `QueueAccessor.getQueue`, which
 * resolves through `ModuleRef` and would otherwise take an arbitrary
 * caller-supplied injection token.
 */
@ApiTags('Queues')
@ApiBearerAuth()
@Controller('queues')
export class QueueAdminController {
  constructor(private readonly service: QueueAdminService) {}

  @Get()
  @RequirePermission('read', 'QueueJob', { administrative: true })
  @ApiOkResponse({ type: [QueueSummaryDto] })
  async summarize(): Promise<QueueSummaryDto[]> {
    return this.service.summarize();
  }

  @Get(':queue/jobs/:jobId')
  @RequirePermission('read', 'QueueJob', { administrative: true })
  @ApiOkResponse({ type: QueueJobResponseDto })
  async findById(
    @Param('queue', new ParseEnumPipe(QueueName)) queue: QueueName,
    @Param('jobId') jobId: string,
    @CurrentAbility() ability: AppAbility,
  ): Promise<QueueJobResponseDto> {
    return this.service.findById(queue, jobId, ability);
  }

  @Post(':queue/jobs/:jobId/retry')
  @RequirePermission('retry', 'QueueJob', { administrative: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  async retry(
    @Param('queue', new ParseEnumPipe(QueueName)) queue: QueueName,
    @Param('jobId') jobId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.service.retry(queue, jobId, user.id);
  }

  @Delete(':queue/jobs/:jobId')
  @RequirePermission('cancel', 'QueueJob', { administrative: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(
    @Param('queue', new ParseEnumPipe(QueueName)) queue: QueueName,
    @Param('jobId') jobId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.service.cancel(queue, jobId, user.id);
  }
}
