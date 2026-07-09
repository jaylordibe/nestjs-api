import { Injectable } from '@nestjs/common';
import { AuditLog, Prisma } from '@prisma/client';
import { buildOrderBy } from '../../common/dto/meta-query.dto';
import { PaginationMeta } from '../../common/dto/paginated-response.dto';
import { Errors } from '../../common/errors/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogQueryDto } from './dto/audit-log-query.dto';

// Read-only. Audit rows are written by `AuditService` and never edited or
// deleted through the API — an audit trail you can mutate is not an audit
// trail. Retention is a separate, deliberate operation.
//
// The composite indexes this relies on — (actorId, createdAt),
// (targetUserId, createdAt), (action, createdAt), (createdAt) — plus the
// trigram GIN index on `metadata::text` that backs `?search=`, are all declared
// in the init migration.
@Injectable()
export class AuditLogsService {
  constructor(private readonly prisma: PrismaService) {}

  async findPaginated(
    query: AuditLogQueryDto,
  ): Promise<{ data: AuditLog[]; meta: PaginationMeta }> {
    const { page, perPage } = query;
    const where = this.buildFilter(query);
    const [data, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: buildOrderBy(
          query,
          ['createdAt', 'action'] as const,
          'createdAt',
        ),
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return {
      data,
      meta: { page, perPage, total, totalPages: Math.ceil(total / perPage) },
    };
  }

  async findById(id: string): Promise<AuditLog> {
    const row = await this.prisma.auditLog.findUnique({ where: { id } });
    if (!row) {
      throw Errors.resourceNotFound('Audit log');
    }
    return row;
  }

  private buildFilter(query: AuditLogQueryDto): Prisma.AuditLogWhereInput {
    const where: Prisma.AuditLogWhereInput = {};

    if (query.action) where.action = query.action;
    if (query.actorId) where.actorId = query.actorId;
    if (query.targetUserId) where.targetUserId = query.targetUserId;

    if (query.fromDate || query.toDate) {
      where.createdAt = {
        ...(query.fromDate ? { gte: new Date(query.fromDate) } : {}),
        // `toDate` is a calendar date, so include the whole day.
        ...(query.toDate
          ? { lt: new Date(new Date(query.toDate).getTime() + 86_400_000) }
          : {}),
      };
    }

    // Substring search across the metadata envelope, backed by the trigram
    // GIN index on `metadata::text`.
    if (query.search) {
      where.metadata = {
        string_contains: query.search,
      };
    }

    return where;
  }
}
