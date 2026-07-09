import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiPaginatedResponse } from '../../common/decorators/api-paginated-response.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { MetaQueryDto } from '../../common/dto/meta-query.dto';
import { PermissionResponseDto } from './dto/permission-response.dto';
import { PermissionsService } from './permissions.service';

// Read-only. Permissions are defined in the code catalog and projected into the
// database; there is no endpoint to create one.
@ApiTags('Permissions')
@Controller('permissions')
export class PermissionsController {
  constructor(private readonly permissionsService: PermissionsService) {}

  // Readable by any authenticated user: it is a vocabulary, like `GET /enums`,
  // and an operator composing a custom role needs to see what can be granted.
  @Get()
  @RequirePermission('read', 'Permission')
  @ApiPaginatedResponse(PermissionResponseDto)
  async findPaginated(
    @Query() query: MetaQueryDto,
  ): Promise<PaginatedResponseDto<PermissionResponseDto>> {
    const { data, meta } = await this.permissionsService.findPaginated(query);
    return { data: data.map((row) => new PermissionResponseDto(row)), meta };
  }
}
