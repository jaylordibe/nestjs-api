import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { AppAbility } from '../../common/authorization/app-ability';
import { ApiPaginatedResponse } from '../../common/decorators/api-paginated-response.decorator';
import { CurrentAbility } from '../../common/decorators/current-ability.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { RoleQueryDto } from './dto/role-query.dto';
import { RoleResponseDto } from './dto/role-response.dto';
import { RolesService } from './roles.service';

/**
 * Roles are READ-ONLY over HTTP.
 *
 * There is no `POST`, `PATCH`, or `DELETE` here, and their absence is the
 * feature. Every role and every role→permission grant is defined in
 * `src/common/authorization/permission-catalog.ts`, reviewed like code, and
 * projected into the database by `yarn prisma:seed`. A runtime-editable role is
 * a privilege-escalation primitive with an audit trail nobody reads: an
 * operator who can add `platform.all.manage` to a role they already hold has
 * made themselves an admin without anyone approving a diff.
 *
 * Guarding such an endpoint with `administrative: true` alone would permit
 * exactly that. It also could not work: the boot-time
 * `PermissionCatalogIntegrityService` fails startup when the database and the
 * catalog disagree, so a custom role's grants are reverted by the next seed
 * anyway.
 */
@ApiTags('Roles')
@ApiBearerAuth()
@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  // Readable by every authenticated user — via AUTHENTICATED_USER_PERMISSIONS,
  // not via a role. A business owner needs a `roleId` before they can invite
  // anyone, and role names and descriptions are a vocabulary, not a secret.
  @Get()
  @RequirePermission('read', 'Role')
  @ApiPaginatedResponse(RoleResponseDto)
  async findPaginated(
    @Query() query: RoleQueryDto,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResponseDto<RoleResponseDto>> {
    const { data, meta } = await this.rolesService.findPaginated(
      query,
      ability,
      user.id,
    );
    return { data: data.map((row) => new RoleResponseDto(row)), meta };
  }

  @Get(':id')
  @RequirePermission('read', 'Role')
  @ApiOkResponse({ type: RoleResponseDto })
  async findById(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<RoleResponseDto> {
    return new RoleResponseDto(await this.rolesService.findById(id));
  }
}
