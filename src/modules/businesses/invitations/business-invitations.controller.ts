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
import { BusinessInvitationsService } from './business-invitations.service';
import { BusinessInvitationResponseDto } from './dto/business-invitation-response.dto';
import { CreateBusinessInvitationDto } from './dto/create-business-invitation.dto';

@ApiTags('Business Invitations')
@ApiBearerAuth()
@Controller('businesses/:businessId/invitations')
export class BusinessInvitationsController {
  constructor(private readonly service: BusinessInvitationsService) {}

  // Every call sends an email to an address the caller chose, which makes this
  // a spam vector on top of the global budget. Tightened accordingly.
  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @RequirePermission('create', 'BusinessInvitation')
  @ApiCreatedResponse({ type: BusinessInvitationResponseDto })
  async create(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Body() dto: CreateBusinessInvitationDto,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BusinessInvitationResponseDto> {
    const { invitation } = await this.service.create(
      businessId,
      dto,
      ability,
      user.id,
    );
    // The plaintext token is deliberately NOT returned. It goes to the invited
    // address and nowhere else — returning it here would let anyone who can
    // invite an address also redeem the invitation themselves, which defeats
    // the point of mailing it.
    return new BusinessInvitationResponseDto(invitation);
  }

  @Get()
  @RequirePermission('read', 'BusinessInvitation', { denyAsNotFound: true })
  @ApiPaginatedResponse(BusinessInvitationResponseDto)
  async findPaginated(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Query() query: MetaQueryDto,
    @CurrentAbility() ability: AppAbility,
  ): Promise<PaginatedResponseDto<BusinessInvitationResponseDto>> {
    const { data, meta } = await this.service.findPaginated(
      businessId,
      query,
      ability,
    );
    return {
      data: data.map((row) => new BusinessInvitationResponseDto(row)),
      meta,
    };
  }

  /**
   * Re-sends a pending invitation on a fresh token.
   *
   * Guarded by `create BusinessInvitation`, not `delete`: resending is the same
   * authority as inviting — same address, same role, same business — and gating
   * it behind `delete` would leave a manager able to raise an invitation they
   * could not repair when the mail went astray.
   *
   * 200, not 201: nothing new comes into existence. The invitation is the same
   * row, carrying a rotated secret.
   */
  @Post(':invitationId/resend')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermission('create', 'BusinessInvitation')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: BusinessInvitationResponseDto })
  async resend(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BusinessInvitationResponseDto> {
    const invitation = await this.service.resend(
      businessId,
      invitationId,
      ability,
      user.id,
    );
    // As with `create`, the plaintext token goes to the invited address and
    // nowhere else.
    return new BusinessInvitationResponseDto(invitation);
  }

  @Delete(':invitationId')
  @RequirePermission('delete', 'BusinessInvitation')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.service.revoke(businessId, invitationId, ability, user.id);
  }
}
