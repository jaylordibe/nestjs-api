import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { AppAbility } from '../../../common/authorization/app-ability';
import { ApiPaginatedResponse } from '../../../common/decorators/api-paginated-response.decorator';
import { CurrentAbility } from '../../../common/decorators/current-ability.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { PaginatedResponseDto } from '../../../common/dto/paginated-response.dto';
import { BusinessMembershipsService } from './business-memberships.service';
import { AddBusinessMembershipDto } from './dto/add-business-membership.dto';
import { BusinessMembershipQueryDto } from './dto/business-membership-query.dto';
import { BusinessMembershipResponseDto } from './dto/business-membership-response.dto';
import { ChangeMembershipRoleDto } from './dto/change-membership-role.dto';
import { UpdateBusinessMembershipDto } from './dto/update-business-membership.dto';

// `:businessId` is the tenant selector `PermissionsGuard` resolves the
// business-scoped condition against. There is deliberately no header or body
// fallback for it on nested routes — an ambient tenant selector is attack
// surface a baseline template should not ship.
//
// This is the ONE canonical membership workflow. Staff and customers are the
// same resource distinguished by role, so there is no parallel `/customers`
// tree to keep in step.
@ApiTags('Business Memberships')
@ApiBearerAuth()
@Controller('businesses/:businessId/memberships')
export class BusinessMembershipsController {
  constructor(private readonly service: BusinessMembershipsService) {}

  @Post()
  @RequirePermission('create', 'BusinessMembership')
  @ApiCreatedResponse({ type: BusinessMembershipResponseDto })
  async create(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Body() dto: AddBusinessMembershipDto,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BusinessMembershipResponseDto> {
    return new BusinessMembershipResponseDto(
      await this.service.add(businessId, dto, ability, user.id),
    );
  }

  // `denyAsNotFound`: a caller with no readable membership here gets an empty
  // page rather than a 403, so the response cannot be used to probe which
  // businesses exist.
  @Get()
  @RequirePermission('read', 'BusinessMembership', { denyAsNotFound: true })
  @ApiPaginatedResponse(BusinessMembershipResponseDto)
  async findPaginated(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Query() query: BusinessMembershipQueryDto,
    @CurrentAbility() ability: AppAbility,
  ): Promise<PaginatedResponseDto<BusinessMembershipResponseDto>> {
    const { data, meta } = await this.service.findPaginated(
      businessId,
      query,
      ability,
    );
    return {
      data: data.map((row) => new BusinessMembershipResponseDto(row)),
      meta,
    };
  }

  @Get(':membershipId')
  @RequirePermission('read', 'BusinessMembership', { denyAsNotFound: true })
  @ApiOkResponse({ type: BusinessMembershipResponseDto })
  async findById(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @CurrentAbility() ability: AppAbility,
  ): Promise<BusinessMembershipResponseDto> {
    return new BusinessMembershipResponseDto(
      await this.service.findById(businessId, membershipId, ability),
    );
  }

  // Annotation only. The role lives behind `assignRole`, suspension behind
  // `suspend`, and ending behind `delete` — folding any of them into a general
  // `update` would let a caller granted the mildest verb perform the most
  // privileged one.
  @Patch(':membershipId')
  @RequirePermission('update', 'BusinessMembership')
  @ApiOkResponse({ type: BusinessMembershipResponseDto })
  async update(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: UpdateBusinessMembershipDto,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BusinessMembershipResponseDto> {
    return new BusinessMembershipResponseDto(
      await this.service.update(
        businessId,
        membershipId,
        dto,
        ability,
        user.id,
      ),
    );
  }

  @Patch(':membershipId/role')
  @RequirePermission('assignRole', 'BusinessMembership')
  @ApiOkResponse({ type: BusinessMembershipResponseDto })
  async changeRole(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: ChangeMembershipRoleDto,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BusinessMembershipResponseDto> {
    return new BusinessMembershipResponseDto(
      await this.service.changeRole(
        businessId,
        membershipId,
        dto,
        ability,
        user.id,
      ),
    );
  }

  @Post(':membershipId/suspend')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('suspend', 'BusinessMembership')
  @ApiOkResponse({ type: BusinessMembershipResponseDto })
  async suspend(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BusinessMembershipResponseDto> {
    return new BusinessMembershipResponseDto(
      await this.service.suspend(businessId, membershipId, ability, user.id),
    );
  }

  @Post(':membershipId/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('suspend', 'BusinessMembership')
  @ApiOkResponse({ type: BusinessMembershipResponseDto })
  async reactivate(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BusinessMembershipResponseDto> {
    return new BusinessMembershipResponseDto(
      await this.service.reactivate(businessId, membershipId, ability, user.id),
    );
  }

  // Ownership transfer is checked against `Business`, not `BusinessMembership`:
  // the thing changing hands is the business, and only its owner may do it.
  @Post(':membershipId/transfer-ownership')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('transferOwnership', 'Business')
  @ApiOkResponse({ type: BusinessMembershipResponseDto })
  async transferOwnership(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BusinessMembershipResponseDto> {
    return new BusinessMembershipResponseDto(
      await this.service.transferOwnership(
        businessId,
        membershipId,
        ability,
        user.id,
      ),
    );
  }

  // Ends the membership. The row is retained — see `BusinessMembershipStatus`.
  @Delete(':membershipId')
  @RequirePermission('delete', 'BusinessMembership')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.service.remove(businessId, membershipId, ability, user.id);
  }
}
