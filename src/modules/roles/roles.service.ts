import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AppAbility } from '../../common/authorization/app-ability';
import { buildOrderBy } from '../../common/dto/meta-query.dto';
import { PaginationMeta } from '../../common/dto/paginated-response.dto';
import { BusinessMembershipStatus } from '../../common/enums/business-membership-status.enum';
import { RoleScope } from '../../common/enums/role-scope.enum';
import { Errors } from '../../common/errors/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { RoleQueryDto } from './dto/role-query.dto';
import type { RoleRow } from './dto/role-response.dto';

const ROLE_INCLUDE = {
  permissions: { include: { permission: true } },
} as const;

/**
 * Read-only projection of `permission-catalog.ts`.
 *
 * There is deliberately no create / update / delete. Roles are code; the
 * `roles` and `role_permissions` tables are a projection written by
 * `yarn prisma:seed`, and `PermissionCatalogIntegrityService` refuses to boot
 * the application if the two ever disagree.
 */
@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  async findPaginated(
    query: RoleQueryDto,
    ability: AppAbility,
    actorId: string,
  ): Promise<{ data: RoleRow[]; meta: PaginationMeta }> {
    const { page, perPage, search } = query;

    const where: Prisma.RoleWhereInput = {};
    if (search) {
      where.name = { contains: search, mode: 'insensitive' };
    }
    if (query.scope) {
      where.scope = query.scope;
    }

    if (query.assignableIn) {
      // An assignment picker: business-scoped roles, capped at the caller's own
      // rank in that business. The write path enforces the same ceiling
      // regardless — this only keeps the UI from offering doors that are
      // locked, and from advertising which roles outrank the viewer.
      where.scope = RoleScope.BUSINESS;
      const ceiling = await this.resolveAssignmentCeiling(
        query.assignableIn,
        actorId,
        ability,
      );
      if (ceiling !== null) {
        where.rank = { lte: ceiling };
      }
    }

    const [data, total] = await this.prisma.$transaction([
      this.prisma.role.findMany({
        where,
        include: ROLE_INCLUDE,
        orderBy: buildOrderBy(
          query,
          ['createdAt', 'name', 'rank', 'scope'] as const,
          'rank',
        ),
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.role.count({ where }),
    ]);

    return {
      data,
      meta: { page, perPage, total, totalPages: Math.ceil(total / perPage) },
    };
  }

  async findById(id: string): Promise<RoleRow> {
    const role = await this.prisma.role.findUnique({
      where: { id },
      include: ROLE_INCLUDE,
    });
    if (!role) {
      throw Errors.resourceNotFound('Role');
    }
    return role;
  }

  /**
   * The caller's assignment ceiling in one business, or `null` for unbounded.
   *
   * Returns an empty ceiling (rank 0, matching nothing) rather than throwing
   * when the caller has no active membership: this is a LIST endpoint, and a
   * 403 here would let anyone probe which businesses they are a member of by
   * watching the status code.
   */
  private async resolveAssignmentCeiling(
    businessId: string,
    actorId: string,
    ability: AppAbility,
  ): Promise<number | null> {
    if (ability.can('manage', 'all')) return null;

    const membership = await this.prisma.businessMembership.findUnique({
      where: { businessId_userId: { businessId, userId: actorId } },
      select: { status: true, role: { select: { rank: true } } },
    });
    if (
      !membership ||
      (membership.status as BusinessMembershipStatus) !==
        BusinessMembershipStatus.ACTIVE
    ) {
      return 0;
    }
    return membership.role.rank;
  }
}
