import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { buildOrderBy, MetaQueryDto } from '../../common/dto/meta-query.dto';
import { PaginationMeta } from '../../common/dto/paginated-response.dto';
import { PrismaService } from '../../prisma/prisma.service';
import type { PermissionRow } from './dto/permission-response.dto';

// Permissions are code-owned: they exist only in
// `src/common/authorization/permission-catalog.ts` and are projected into the
// database by `yarn rbac:sync`. There is deliberately no write path — a
// permission the code cannot reference is a permission no guard can check.
//
// Separate from RolesService because roles are DATA (operators create them) and
// permissions are CODE. Different lifecycles, different owners.
@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  async findPaginated(
    query: MetaQueryDto,
  ): Promise<{ data: PermissionRow[]; meta: PaginationMeta }> {
    const { page, perPage } = query;
    const where: Prisma.PermissionWhereInput = query.search
      ? { name: { contains: query.search, mode: 'insensitive' } }
      : {};
    const [data, total] = await this.prisma.$transaction([
      this.prisma.permission.findMany({
        where,
        orderBy: buildOrderBy(query, ['name', 'scope'] as const, 'name'),
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.permission.count({ where }),
    ]);
    return {
      data,
      meta: { page, perPage, total, totalPages: Math.ceil(total / perPage) },
    };
  }
}
