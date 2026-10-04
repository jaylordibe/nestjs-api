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
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ApiPaginatedResponse } from '../../common/decorators/api-paginated-response.decorator';
import { CurrentAbility } from '../../common/decorators/current-ability.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { AppAbility } from '../../common/authorization/app-ability';
import { MetaQueryDto } from '../../common/dto/meta-query.dto';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { WorkspacesService } from './workspaces.service';
import { WorkspaceResponseDto } from './dto/workspace-response.dto';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';

@ApiTags('Workspaces')
@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly workspacesService: WorkspacesService) {}

  // Any authenticated caller may start a workspace — `create Workspace` is one of
  // the intrinsic AUTHENTICATED_USER_PERMISSIONS. The creator becomes its
  // WORKSPACE_OWNER in the same transaction.
  @Post()
  @RequirePermission('create', 'Workspace')
  @ApiCreatedResponse({ type: WorkspaceResponseDto })
  async create(
    @Body() dto: CreateWorkspaceDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<WorkspaceResponseDto> {
    const workspace = await this.workspacesService.create(dto, currentUser.id);
    return new WorkspaceResponseDto(workspace);
  }

  // `denyAsNotFound` — a user who belongs to no workspace gets an empty page,
  // not a 403. The query scopes the result either way.
  @Get()
  @RequirePermission('read', 'Workspace', { denyAsNotFound: true })
  @ApiPaginatedResponse(WorkspaceResponseDto)
  async findPaginated(
    @Query() query: MetaQueryDto,
    @CurrentAbility() ability: AppAbility,
  ): Promise<PaginatedResponseDto<WorkspaceResponseDto>> {
    const { data, meta } = await this.workspacesService.findPaginated(
      query,
      ability,
    );
    return { data: data.map((row) => new WorkspaceResponseDto(row)), meta };
  }

  // A workspace the caller is not a member of returns 404, never 403 — a 403
  // would confirm it exists.
  @Get(':id')
  @RequirePermission('read', 'Workspace', { denyAsNotFound: true })
  @ApiOkResponse({ type: WorkspaceResponseDto })
  async findById(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAbility() ability: AppAbility,
  ): Promise<WorkspaceResponseDto> {
    const workspace = await this.workspacesService.findById(id, ability);
    return new WorkspaceResponseDto(workspace);
  }

  @Patch(':id')
  @RequirePermission('update', 'Workspace', { denyAsNotFound: true })
  @ApiOkResponse({ type: WorkspaceResponseDto })
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateWorkspaceDto,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<WorkspaceResponseDto> {
    const workspace = await this.workspacesService.update(
      id,
      dto,
      ability,
      currentUser.id,
    );
    return new WorkspaceResponseDto(workspace);
  }

  @Delete(':id')
  @RequirePermission('delete', 'Workspace', { denyAsNotFound: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<void> {
    await this.workspacesService.remove(id, ability, currentUser.id);
  }
}
