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
import { Roles } from '../../common/decorators/roles.decorator';
import { MetaQueryDto } from '../../common/dto/meta-query.dto';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { Role } from '../../common/enums/role.enum';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateDeviceTokenDto } from './dto/create-device-token.dto';
import { DeviceTokenResponseDto } from './dto/device-token-response.dto';
import { UpdateDeviceTokenDto } from './dto/update-device-token.dto';
import { DeviceTokensService } from './device-tokens.service';

@ApiTags('Device Tokens')
@ApiBearerAuth()
@Controller('device-tokens')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DeviceTokensController {
  constructor(private readonly deviceTokensService: DeviceTokensService) {}

  @Post()
  @Roles(Role.ADMIN)
  async create(
    @Body() dto: CreateDeviceTokenDto,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<DeviceTokenResponseDto> {
    const row = await this.deviceTokensService.create(dto, current.id);
    return new DeviceTokenResponseDto(row);
  }

  @Get()
  @Roles(Role.ADMIN)
  async findPaginated(
    @Query() query: MetaQueryDto,
  ): Promise<PaginatedResponseDto<DeviceTokenResponseDto>> {
    const { data, meta } = await this.deviceTokensService.findPaginated(query);
    return {
      data: data.map((r) => new DeviceTokenResponseDto(r)),
      meta,
    };
  }

  @Get(':id')
  @Roles(Role.ADMIN)
  async findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<DeviceTokenResponseDto> {
    const row = await this.deviceTokensService.findById(id);
    return new DeviceTokenResponseDto(row);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateDeviceTokenDto,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<DeviceTokenResponseDto> {
    const row = await this.deviceTokensService.update(id, dto, current.id);
    return new DeviceTokenResponseDto(row);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<void> {
    await this.deviceTokensService.remove(id, current.id);
  }
}
