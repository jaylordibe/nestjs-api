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
import { ApiPaginatedResponse } from '../../common/decorators/api-paginated-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { CurrentAbility } from '../../common/decorators/current-ability.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { MetaQueryDto } from '../../common/dto/meta-query.dto';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import type { AppAbility } from '../../common/authorization/app-ability';
import { CreateDeviceTokenDto } from './dto/create-device-token.dto';
import { DeviceTokenResponseDto } from './dto/device-token-response.dto';
import { UpdateDeviceTokenDto } from './dto/update-device-token.dto';
import { DeviceTokensService } from './device-tokens.service';

@ApiTags('Device Tokens')
@ApiBearerAuth()
@Controller('device-tokens')
export class DeviceTokensController {
  constructor(private readonly deviceTokensService: DeviceTokensService) {}

  @Post()
  @RequirePermission('create', 'DeviceToken')
  @ApiCreatedResponse({ type: DeviceTokenResponseDto })
  async create(
    @Body() dto: CreateDeviceTokenDto,
    @CurrentUser() current: AuthenticatedUser,
    @CurrentAbility() ability: AppAbility,
  ): Promise<DeviceTokenResponseDto> {
    const row = await this.deviceTokensService.create(dto, ability, current.id);
    return new DeviceTokenResponseDto(row);
  }

  @Get()
  @RequirePermission('read', 'DeviceToken')
  @ApiPaginatedResponse(DeviceTokenResponseDto)
  async findPaginated(
    @Query() query: MetaQueryDto,
    @CurrentAbility() ability: AppAbility,
  ): Promise<PaginatedResponseDto<DeviceTokenResponseDto>> {
    const { data, meta } = await this.deviceTokensService.findPaginated(
      query,
      ability,
    );
    return {
      data: data.map((row) => new DeviceTokenResponseDto(row)),
      meta,
    };
  }

  @Get(':id')
  @RequirePermission('read', 'DeviceToken')
  @ApiOkResponse({ type: DeviceTokenResponseDto })
  async findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAbility() ability: AppAbility,
  ): Promise<DeviceTokenResponseDto> {
    const row = await this.deviceTokensService.findById(id, ability);
    return new DeviceTokenResponseDto(row);
  }

  @Patch(':id')
  @RequirePermission('update', 'DeviceToken')
  @ApiOkResponse({ type: DeviceTokenResponseDto })
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateDeviceTokenDto,
    @CurrentUser() current: AuthenticatedUser,
    @CurrentAbility() ability: AppAbility,
  ): Promise<DeviceTokenResponseDto> {
    const row = await this.deviceTokensService.update(
      id,
      dto,
      ability,
      current.id,
    );
    return new DeviceTokenResponseDto(row);
  }

  @Delete(':id')
  @RequirePermission('delete', 'DeviceToken')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() current: AuthenticatedUser,
    @CurrentAbility() ability: AppAbility,
  ): Promise<void> {
    await this.deviceTokensService.remove(id, ability, current.id);
  }
}
