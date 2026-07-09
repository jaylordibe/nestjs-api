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
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { MetaQueryDto } from '../../common/dto/meta-query.dto';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { CreateRoleDto } from './dto/create-role.dto';
import { RoleResponseDto } from './dto/role-response.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { RolesService } from './roles.service';

@ApiTags('Roles')
@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Post()
  @RequirePermission('create', 'Role', { administrative: true })
  @ApiCreatedResponse({ type: RoleResponseDto })
  async create(
    @Body() dto: CreateRoleDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<RoleResponseDto> {
    return new RoleResponseDto(
      await this.rolesService.create(dto, currentUser.id),
    );
  }

  // Readable by every authenticated user: a business owner needs a `roleId`
  // before they can add anyone to their roster. Role names and descriptions
  // are a vocabulary, not a secret.
  @Get()
  @RequirePermission('read', 'Role')
  @ApiPaginatedResponse(RoleResponseDto)
  async findPaginated(
    @Query() query: MetaQueryDto,
  ): Promise<PaginatedResponseDto<RoleResponseDto>> {
    const { data, meta } = await this.rolesService.findPaginated(query);
    return { data: data.map((row) => new RoleResponseDto(row)), meta };
  }

  @Get(':id')
  @RequirePermission('read', 'Role')
  @ApiOkResponse({ type: RoleResponseDto })
  async findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<RoleResponseDto> {
    return new RoleResponseDto(await this.rolesService.findById(id));
  }

  @Patch(':id')
  @RequirePermission('update', 'Role', { administrative: true })
  @ApiOkResponse({ type: RoleResponseDto })
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<RoleResponseDto> {
    return new RoleResponseDto(
      await this.rolesService.update(id, dto, currentUser.id),
    );
  }

  @Delete(':id')
  @RequirePermission('delete', 'Role', { administrative: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<void> {
    await this.rolesService.remove(id, currentUser.id);
  }
}
