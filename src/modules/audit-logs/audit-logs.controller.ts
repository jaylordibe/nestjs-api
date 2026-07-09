import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ApiPaginatedResponse } from '../../common/decorators/api-paginated-response.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { AuditLogsService } from './audit-logs.service';
import { AuditLogQueryDto } from './dto/audit-log-query.dto';
import { AuditLogResponseDto } from './dto/audit-log-response.dto';

// The audit trail is platform-wide and reveals who did what to whom, so it is
// strictly administrative: PLATFORM_ADMIN, PLATFORM_SUPPORT, and
// PLATFORM_DEVELOPER hold `read AuditLog`. No self-service view — a user's own
// audit rows still name other actors.
@ApiTags('Audit Logs')
@Controller('audit-logs')
export class AuditLogsController {
  constructor(private readonly auditLogsService: AuditLogsService) {}

  @Get()
  @RequirePermission('read', 'AuditLog', { administrative: true })
  @ApiPaginatedResponse(AuditLogResponseDto)
  async findPaginated(
    @Query() query: AuditLogQueryDto,
  ): Promise<PaginatedResponseDto<AuditLogResponseDto>> {
    const { data, meta } = await this.auditLogsService.findPaginated(query);
    return { data: data.map((row) => new AuditLogResponseDto(row)), meta };
  }

  @Get(':id')
  @RequirePermission('read', 'AuditLog', { administrative: true })
  @ApiOkResponse({ type: AuditLogResponseDto })
  async findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AuditLogResponseDto> {
    return new AuditLogResponseDto(await this.auditLogsService.findById(id));
  }
}
