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
import { ApiPaginatedResponse } from '../../../common/decorators/api-paginated-response.decorator';
import { CurrentAbility } from '../../../common/decorators/current-ability.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import type { AppAbility } from '../../../common/authorization/app-ability';
import { MetaQueryDto } from '../../../common/dto/meta-query.dto';
import { PaginatedResponseDto } from '../../../common/dto/paginated-response.dto';
import { BusinessCustomersService } from './business-customers.service';
import { AddBusinessCustomerDto } from './dto/add-business-customer.dto';
import { BusinessCustomerResponseDto } from './dto/business-customer-response.dto';
import { UpdateBusinessCustomerDto } from './dto/update-business-customer.dto';

/**
 * A customer of a business — NOT a member, and not a role.
 *
 * `PermissionsGuard` checks each rule against `{ businessId, userId: caller }`,
 * so both audiences pass the same decorator: staff via their tenant-scoped
 * rule, a customer via their ownership-scoped one. Which records they can then
 * touch is decided by the query and by the service's instance checks.
 */
@ApiTags('Business Customers')
@Controller('businesses/:businessId/customers')
export class BusinessCustomersController {
  constructor(
    private readonly businessCustomersService: BusinessCustomersService,
  ) {}

  // No `email` in the body → the caller enrols themselves. With an `email` →
  // the caller enrols someone else, which only a staff-scoped grant satisfies.
  @Post()
  @RequirePermission('create', 'BusinessCustomer')
  @ApiCreatedResponse({ type: BusinessCustomerResponseDto })
  async add(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Body() dto: AddBusinessCustomerDto,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<BusinessCustomerResponseDto> {
    const customer = await this.businessCustomersService.add(
      businessId,
      dto,
      ability,
      currentUser.id,
    );
    return new BusinessCustomerResponseDto(customer);
  }

  // Staff see the whole customer list; a customer sees only their own row.
  @Get()
  @RequirePermission('read', 'BusinessCustomer', { denyAsNotFound: true })
  @ApiPaginatedResponse(BusinessCustomerResponseDto)
  async findPaginated(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Query() query: MetaQueryDto,
    @CurrentAbility() ability: AppAbility,
  ): Promise<PaginatedResponseDto<BusinessCustomerResponseDto>> {
    const { data, meta } = await this.businessCustomersService.findPaginated(
      businessId,
      query,
      ability,
    );
    return {
      data: data.map((row) => new BusinessCustomerResponseDto(row)),
      meta,
    };
  }

  @Get(':customerId')
  @RequirePermission('read', 'BusinessCustomer', { denyAsNotFound: true })
  @ApiOkResponse({ type: BusinessCustomerResponseDto })
  async findOne(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @CurrentAbility() ability: AppAbility,
  ): Promise<BusinessCustomerResponseDto> {
    const customer = await this.businessCustomersService.findById(
      businessId,
      customerId,
      ability,
    );
    return new BusinessCustomerResponseDto(customer);
  }

  // Staff-only in practice: a customer holds no `update` grant, so the instance
  // check in the service refuses them even though they can read the row.
  @Patch(':customerId')
  @RequirePermission('update', 'BusinessCustomer')
  @ApiOkResponse({ type: BusinessCustomerResponseDto })
  async update(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @Body() dto: UpdateBusinessCustomerDto,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<BusinessCustomerResponseDto> {
    const customer = await this.businessCustomersService.update(
      businessId,
      customerId,
      dto,
      ability,
      currentUser.id,
    );
    return new BusinessCustomerResponseDto(customer);
  }

  // A customer may end their own relationship; staff may remove anyone's.
  @Delete(':customerId')
  @RequirePermission('delete', 'BusinessCustomer')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<void> {
    await this.businessCustomersService.remove(
      businessId,
      customerId,
      ability,
      currentUser.id,
    );
  }
}
