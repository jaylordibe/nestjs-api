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
import { BusinessesService } from './businesses.service';
import { BusinessResponseDto } from './dto/business-response.dto';
import { CreateBusinessDto } from './dto/create-business.dto';
import { UpdateBusinessDto } from './dto/update-business.dto';

@ApiTags('Businesses')
@Controller('businesses')
export class BusinessesController {
  constructor(private readonly businessesService: BusinessesService) {}

  // Any registered user may start a business — `create Business` ships with
  // PLATFORM_USER. The creator becomes its BUSINESS_OWNER in the same
  // transaction.
  @Post()
  @RequirePermission('create', 'Business')
  @ApiCreatedResponse({ type: BusinessResponseDto })
  async create(
    @Body() dto: CreateBusinessDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<BusinessResponseDto> {
    const business = await this.businessesService.create(dto, currentUser.id);
    return new BusinessResponseDto(business);
  }

  // `denyAsNotFound` — a user who belongs to no business gets an empty page,
  // not a 403. The query scopes the result either way.
  @Get()
  @RequirePermission('read', 'Business', { denyAsNotFound: true })
  @ApiPaginatedResponse(BusinessResponseDto)
  async findPaginated(
    @Query() query: MetaQueryDto,
    @CurrentAbility() ability: AppAbility,
  ): Promise<PaginatedResponseDto<BusinessResponseDto>> {
    const { data, meta } = await this.businessesService.findPaginated(
      query,
      ability,
    );
    return { data: data.map((row) => new BusinessResponseDto(row)), meta };
  }

  // A business the caller is not a member of returns 404, never 403 — a 403
  // would confirm it exists.
  @Get(':id')
  @RequirePermission('read', 'Business', { denyAsNotFound: true })
  @ApiOkResponse({ type: BusinessResponseDto })
  async findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAbility() ability: AppAbility,
  ): Promise<BusinessResponseDto> {
    const business = await this.businessesService.findById(id, ability);
    return new BusinessResponseDto(business);
  }

  @Patch(':id')
  @RequirePermission('update', 'Business', { denyAsNotFound: true })
  @ApiOkResponse({ type: BusinessResponseDto })
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateBusinessDto,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<BusinessResponseDto> {
    const business = await this.businessesService.update(
      id,
      dto,
      ability,
      currentUser.id,
    );
    return new BusinessResponseDto(business);
  }

  @Delete(':id')
  @RequirePermission('delete', 'Business', { denyAsNotFound: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<void> {
    await this.businessesService.remove(id, ability, currentUser.id);
  }
}
