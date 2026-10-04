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
import { WorkspaceMembershipsService } from './workspace-memberships.service';
import { AddWorkspaceMembershipDto } from './dto/add-workspace-membership.dto';
import { WorkspaceMembershipQueryDto } from './dto/workspace-membership-query.dto';
import { WorkspaceMembershipResponseDto } from './dto/workspace-membership-response.dto';
import { ChangeMembershipRoleDto } from './dto/change-membership-role.dto';
import { UpdateWorkspaceMembershipDto } from './dto/update-workspace-membership.dto';

// `:workspaceId` is the tenant selector `PermissionsGuard` resolves the
// workspace-scoped condition against. There is deliberately no header or body
// fallback for it on nested routes — an ambient tenant selector is attack
// surface a baseline template should not ship.
//
// This is the ONE canonical membership workflow. Every role is the same
// resource distinguished by `roleId`, so there is no parallel tree per role to
// keep in step.
@ApiTags('Workspace Memberships')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/memberships')
export class WorkspaceMembershipsController {
  constructor(private readonly service: WorkspaceMembershipsService) {}

  @Post()
  @RequirePermission('create', 'WorkspaceMembership')
  @ApiCreatedResponse({ type: WorkspaceMembershipResponseDto })
  async create(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body() dto: AddWorkspaceMembershipDto,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkspaceMembershipResponseDto> {
    return new WorkspaceMembershipResponseDto(
      await this.service.add(workspaceId, dto, ability, user.id),
    );
  }

  // `denyAsNotFound`: a caller with no readable membership here gets an empty
  // page rather than a 403, so the response cannot be used to probe which
  // workspaces exist.
  @Get()
  @RequirePermission('read', 'WorkspaceMembership', { denyAsNotFound: true })
  @ApiPaginatedResponse(WorkspaceMembershipResponseDto)
  async findPaginated(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query() query: WorkspaceMembershipQueryDto,
    @CurrentAbility() ability: AppAbility,
  ): Promise<PaginatedResponseDto<WorkspaceMembershipResponseDto>> {
    const { data, meta } = await this.service.findPaginated(
      workspaceId,
      query,
      ability,
    );
    return {
      data: data.map((row) => new WorkspaceMembershipResponseDto(row)),
      meta,
    };
  }

  @Get(':membershipId')
  @RequirePermission('read', 'WorkspaceMembership', { denyAsNotFound: true })
  @ApiOkResponse({ type: WorkspaceMembershipResponseDto })
  async findById(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @CurrentAbility() ability: AppAbility,
  ): Promise<WorkspaceMembershipResponseDto> {
    return new WorkspaceMembershipResponseDto(
      await this.service.findById(workspaceId, membershipId, ability),
    );
  }

  // Annotation only. The role lives behind `assignRole`, suspension behind
  // `suspend`, and ending behind `delete` — folding any of them into a general
  // `update` would let a caller granted the mildest verb perform the most
  // privileged one.
  @Patch(':membershipId')
  @RequirePermission('update', 'WorkspaceMembership')
  @ApiOkResponse({ type: WorkspaceMembershipResponseDto })
  async update(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: UpdateWorkspaceMembershipDto,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkspaceMembershipResponseDto> {
    return new WorkspaceMembershipResponseDto(
      await this.service.update(
        workspaceId,
        membershipId,
        dto,
        ability,
        user.id,
      ),
    );
  }

  @Patch(':membershipId/role')
  @RequirePermission('assignRole', 'WorkspaceMembership')
  @ApiOkResponse({ type: WorkspaceMembershipResponseDto })
  async changeRole(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: ChangeMembershipRoleDto,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkspaceMembershipResponseDto> {
    return new WorkspaceMembershipResponseDto(
      await this.service.changeRole(
        workspaceId,
        membershipId,
        dto,
        ability,
        user.id,
      ),
    );
  }

  @Post(':membershipId/suspend')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('suspend', 'WorkspaceMembership')
  @ApiOkResponse({ type: WorkspaceMembershipResponseDto })
  async suspend(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkspaceMembershipResponseDto> {
    return new WorkspaceMembershipResponseDto(
      await this.service.suspend(workspaceId, membershipId, ability, user.id),
    );
  }

  @Post(':membershipId/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('suspend', 'WorkspaceMembership')
  @ApiOkResponse({ type: WorkspaceMembershipResponseDto })
  async reactivate(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkspaceMembershipResponseDto> {
    return new WorkspaceMembershipResponseDto(
      await this.service.reactivate(
        workspaceId,
        membershipId,
        ability,
        user.id,
      ),
    );
  }

  // Ownership transfer is checked against `Workspace`, not `WorkspaceMembership`:
  // the thing changing hands is the workspace, and only its owner may do it.
  @Post(':membershipId/transfer-ownership')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('transferOwnership', 'Workspace')
  @ApiOkResponse({ type: WorkspaceMembershipResponseDto })
  async transferOwnership(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkspaceMembershipResponseDto> {
    return new WorkspaceMembershipResponseDto(
      await this.service.transferOwnership(
        workspaceId,
        membershipId,
        ability,
        user.id,
      ),
    );
  }

  // Ends the membership. The row is retained — see `WorkspaceMembershipStatus`.
  @Delete(':membershipId')
  @RequirePermission('delete', 'WorkspaceMembership')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.service.remove(workspaceId, membershipId, ability, user.id);
  }
}
