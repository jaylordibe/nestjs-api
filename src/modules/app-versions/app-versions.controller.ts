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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { MetaQueryDto } from '../../common/dto/meta-query.dto';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { Role } from '../../common/enums/role.enum';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AppVersionResponseDto } from './dto/app-version-response.dto';
import { CreateAppVersionDto } from './dto/create-app-version.dto';
import { LatestAppVersionQueryDto } from './dto/latest-app-version-query.dto';
import { UpdateAppVersionDto } from './dto/update-app-version.dto';
import { AppVersionsService } from './app-versions.service';

// Reads are `@Public()` because apps typically hit a version-check endpoint
// at launch, before any user has authenticated. Writes require admin.
@ApiTags('App Versions')
@ApiBearerAuth()
@Controller('app-versions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AppVersionsController {
  constructor(private readonly appVersionsService: AppVersionsService) {}

  @Post()
  @Roles(Role.ADMIN)
  async create(
    @Body() dto: CreateAppVersionDto,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<AppVersionResponseDto> {
    const row = await this.appVersionsService.create(dto, current.id);
    return new AppVersionResponseDto(row);
  }

  @Get()
  @Public()
  async findPaginated(
    @Query() query: MetaQueryDto,
  ): Promise<PaginatedResponseDto<AppVersionResponseDto>> {
    const { data, meta } = await this.appVersionsService.findPaginated(query);
    return {
      data: data.map((r) => new AppVersionResponseDto(r)),
      meta,
    };
  }

  // Must be before @Get(':id') — NestJS matches routes in declaration order.
  @Get('all')
  @Public()
  async findAll(
    @Query() query: MetaQueryDto,
  ): Promise<AppVersionResponseDto[]> {
    const rows = await this.appVersionsService.findAll(query);
    return rows.map((r) => new AppVersionResponseDto(r));
  }

  // Also before @Get(':id'). Clients hit `/latest?platform=mobile` at app
  // launch to decide whether to prompt an update.
  @Get('latest')
  @Public()
  async findLatest(
    @Query() query: LatestAppVersionQueryDto,
  ): Promise<AppVersionResponseDto> {
    const row = await this.appVersionsService.findLatestByPlatform(
      query.platform,
    );
    return new AppVersionResponseDto(row);
  }

  @Get(':id')
  @Public()
  async findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AppVersionResponseDto> {
    const row = await this.appVersionsService.findById(id);
    return new AppVersionResponseDto(row);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateAppVersionDto,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<AppVersionResponseDto> {
    const row = await this.appVersionsService.update(id, dto, current.id);
    return new AppVersionResponseDto(row);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<void> {
    await this.appVersionsService.remove(id, current.id);
  }
}
