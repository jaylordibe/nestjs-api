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
import { BusinessMembersService } from './business-members.service';
import { AddBusinessMemberDto } from './dto/add-business-member.dto';
import { BusinessMemberResponseDto } from './dto/business-member-response.dto';
import { UpdateBusinessMemberDto } from './dto/update-business-member.dto';

// `:businessId` is the canonical tenant selector. `PermissionsGuard` reads it
// and evaluates each rule's `{ businessId }` condition against it, so a member
// of business A is refused on business B's roster before this controller runs.
@ApiTags('Business Members')
@Controller('businesses/:businessId/members')
export class BusinessMembersController {
  constructor(
    private readonly businessMembersService: BusinessMembersService,
  ) {}

  @Post()
  @RequirePermission('create', 'BusinessMember')
  @ApiCreatedResponse({ type: BusinessMemberResponseDto })
  async add(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Body() dto: AddBusinessMemberDto,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<BusinessMemberResponseDto> {
    const member = await this.businessMembersService.add(
      businessId,
      dto,
      ability,
      currentUser.id,
    );
    return new BusinessMemberResponseDto(member);
  }

  @Get()
  @RequirePermission('read', 'BusinessMember')
  @ApiPaginatedResponse(BusinessMemberResponseDto)
  async findPaginated(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Query() query: MetaQueryDto,
  ): Promise<PaginatedResponseDto<BusinessMemberResponseDto>> {
    const { data, meta } = await this.businessMembersService.findPaginated(
      businessId,
      query,
    );
    return {
      data: data.map((row) => new BusinessMemberResponseDto(row)),
      meta,
    };
  }

  @Get(':memberId')
  @RequirePermission('read', 'BusinessMember')
  @ApiOkResponse({ type: BusinessMemberResponseDto })
  async findOne(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('memberId', new ParseUUIDPipe()) memberId: string,
  ): Promise<BusinessMemberResponseDto> {
    const member = await this.businessMembersService.findById(
      businessId,
      memberId,
    );
    return new BusinessMemberResponseDto(member);
  }

  // `assignRole`, not `update` — handing out roles is the escalation surface,
  // and CASL's `manage` wildcard would otherwise swallow it silently.
  @Patch(':memberId')
  @RequirePermission('assignRole', 'BusinessMember')
  @ApiOkResponse({ type: BusinessMemberResponseDto })
  async changeRole(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('memberId', new ParseUUIDPipe()) memberId: string,
    @Body() dto: UpdateBusinessMemberDto,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<BusinessMemberResponseDto> {
    const member = await this.businessMembersService.changeRole(
      businessId,
      memberId,
      dto,
      ability,
      currentUser.id,
    );
    return new BusinessMemberResponseDto(member);
  }

  @Delete(':memberId')
  @RequirePermission('delete', 'BusinessMember')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('memberId', new ParseUUIDPipe()) memberId: string,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<void> {
    await this.businessMembersService.remove(
      businessId,
      memberId,
      ability,
      currentUser.id,
    );
  }
}
