import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AppAbility } from '../../../common/authorization/app-ability';
import { ApiPaginatedResponse } from '../../../common/decorators/api-paginated-response.decorator';
import { CurrentAbility } from '../../../common/decorators/current-ability.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { MetaQueryDto } from '../../../common/dto/meta-query.dto';
import { PaginatedResponseDto } from '../../../common/dto/paginated-response.dto';
import { WorkspaceInvitationsService } from './workspace-invitations.service';
import { WorkspaceInvitationResponseDto } from './dto/workspace-invitation-response.dto';
import { CreateWorkspaceInvitationDto } from './dto/create-workspace-invitation.dto';

@ApiTags('Workspace Invitations')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/invitations')
export class WorkspaceInvitationsController {
  constructor(private readonly service: WorkspaceInvitationsService) {}

  // Every call sends an email to an address the caller chose, which makes this
  // a spam vector on top of the global budget. Tightened accordingly.
  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @RequirePermission('create', 'WorkspaceInvitation')
  @ApiCreatedResponse({ type: WorkspaceInvitationResponseDto })
  async create(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body() dto: CreateWorkspaceInvitationDto,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkspaceInvitationResponseDto> {
    const { invitation } = await this.service.create(
      workspaceId,
      dto,
      ability,
      user.id,
    );
    // The plaintext token is deliberately NOT returned. It goes to the invited
    // address and nowhere else — returning it here would let anyone who can
    // invite an address also redeem the invitation themselves, which defeats
    // the point of mailing it.
    return new WorkspaceInvitationResponseDto(invitation);
  }

  @Get()
  @RequirePermission('read', 'WorkspaceInvitation', { denyAsNotFound: true })
  @ApiPaginatedResponse(WorkspaceInvitationResponseDto)
  async findPaginated(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query() query: MetaQueryDto,
    @CurrentAbility() ability: AppAbility,
  ): Promise<PaginatedResponseDto<WorkspaceInvitationResponseDto>> {
    const { data, meta } = await this.service.findPaginated(
      workspaceId,
      query,
      ability,
    );
    return {
      data: data.map((row) => new WorkspaceInvitationResponseDto(row)),
      meta,
    };
  }

  /**
   * Re-sends a pending invitation on a fresh token.
   *
   * Guarded by `create WorkspaceInvitation`, not `delete`: resending is the same
   * authority as inviting — same address, same role, same workspace — and gating
   * it behind `delete` would leave a manager able to raise an invitation they
   * could not repair when the mail went astray.
   *
   * 200, not 201: nothing new comes into existence. The invitation is the same
   * row, carrying a rotated secret.
   */
  @Post(':invitationId/resend')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermission('create', 'WorkspaceInvitation')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: WorkspaceInvitationResponseDto })
  async resend(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkspaceInvitationResponseDto> {
    const invitation = await this.service.resend(
      workspaceId,
      invitationId,
      ability,
      user.id,
    );
    // As with `create`, the plaintext token goes to the invited address and
    // nowhere else.
    return new WorkspaceInvitationResponseDto(invitation);
  }

  @Delete(':invitationId')
  @RequirePermission('delete', 'WorkspaceInvitation')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.service.revoke(workspaceId, invitationId, ability, user.id);
  }
}
