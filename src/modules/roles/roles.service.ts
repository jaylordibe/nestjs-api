import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { buildOrderBy, MetaQueryDto } from '../../common/dto/meta-query.dto';
import { PaginationMeta } from '../../common/dto/paginated-response.dto';
import { RoleScope } from '../../common/enums/role-scope.enum';
import { Errors } from '../../common/errors/errors';
import { buildAuditSnapshot } from '../../common/util/audit-snapshot.util';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionLoaderService } from '../authorization/permission-loader.service';
import { CreateRoleDto } from './dto/create-role.dto';
import type { RoleRow } from './dto/role-response.dto';
import { UpdateRoleDto } from './dto/update-role.dto';

const ROLE_INCLUDE = {
  permissions: { include: { permission: true } },
} as const;

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly permissionLoaderService: PermissionLoaderService,
  ) {}

  async create(dto: CreateRoleDto, actorId: string): Promise<RoleRow> {
    const permissions = await this.loadPermissionsForScope(
      dto.permissionIds,
      dto.scope,
    );

    const role = await this.prisma.role.create({
      data: {
        name: dto.name,
        scope: dto.scope,
        rank: dto.rank,
        description: dto.description,
        isSystem: false,
        createdBy: actorId,
        updatedBy: actorId,
        permissions: {
          create: permissions.map((permission) => ({
            permissionId: permission.id,
            createdBy: actorId,
          })),
        },
      },
      include: ROLE_INCLUDE,
    });

    await this.auditService.record({
      action: 'role.created',
      actorId,
      metadata: { roleId: role.id, roleName: role.name, scope: role.scope },
    });
    return role;
  }

  async findPaginated(
    query: MetaQueryDto,
  ): Promise<{ data: RoleRow[]; meta: PaginationMeta }> {
    const { page, perPage } = query;
    const where: Prisma.RoleWhereInput = query.search
      ? { name: { contains: query.search, mode: 'insensitive' } }
      : {};
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

  async update(
    id: string,
    dto: UpdateRoleDto,
    actorId: string,
  ): Promise<RoleRow> {
    const existing = await this.findById(id);
    this.assertNotSystemRole(existing, 'edited');

    if (dto.permissionIds) {
      const permissions = await this.loadPermissionsForScope(
        dto.permissionIds,
        existing.scope as RoleScope,
      );
      await this.prisma.$transaction([
        this.prisma.rolePermission.deleteMany({ where: { roleId: id } }),
        this.prisma.rolePermission.createMany({
          data: permissions.map((permission) => ({
            roleId: id,
            permissionId: permission.id,
            createdBy: actorId,
          })),
        }),
      ]);
    }

    const updated = await this.prisma.role.update({
      where: { id },
      data: {
        name: dto.name,
        rank: dto.rank,
        description: dto.description,
        updatedBy: actorId,
      },
      include: ROLE_INCLUDE,
    });

    // A role's permission set changed, which affects EVERY holder of that
    // role — potentially the whole platform. One atomic epoch bump retires
    // every cached grant rather than hunting down each holder.
    await this.permissionLoaderService.invalidateAllUsers();
    await this.auditService.record({
      action: 'role.updated',
      actorId,
      metadata: {
        roleId: id,
        roleName: updated.name,
        permissionsChanged: dto.permissionIds !== undefined,
      },
    });
    return updated;
  }

  async remove(id: string, actorId: string): Promise<void> {
    const existing = await this.findById(id);
    this.assertNotSystemRole(existing, 'deleted');

    // `onDelete: Restrict` on user_roles / business_members means the database
    // refuses to strip a role out from under its holders. Surface that as a
    // clean 409 rather than an opaque FK error.
    const assignmentCount =
      (await this.prisma.userRole.count({ where: { roleId: id } })) +
      (await this.prisma.businessMember.count({ where: { roleId: id } }));
    if (assignmentCount > 0) {
      throw Errors.resourceConflict(
        `Role is still assigned to ${assignmentCount} principal(s). Reassign them first.`,
      );
    }

    await this.prisma.role.delete({ where: { id } });
    await this.permissionLoaderService.invalidateAllUsers();
    await this.auditService.record({
      action: 'role.deleted',
      actorId,
      metadata: {
        roleId: id,
        roleName: existing.name,
        snapshot: buildAuditSnapshot({ ...existing, permissions: undefined }),
      },
    });
  }

  // Seeded roles are a projection of `permission-catalog.ts`. Editing one
  // through the API would be reverted by the next `yarn prisma:seed`, and the
  // boot-time integrity check would fail in between. Refuse loudly.
  private assertNotSystemRole(role: RoleRow, verb: string): void {
    if (role.isSystem) {
      throw Errors.resourceConflict(
        `"${role.name}" is a system role defined in the permission catalog and cannot be ${verb}. ` +
          'Create a custom role instead.',
      );
    }
  }

  // A PLATFORM role holding a BUSINESS permission would compile into a CASL
  // rule with a tenant condition it can never satisfy — a silently dead grant.
  private async loadPermissionsForScope(
    permissionIds: string[],
    scope: RoleScope,
  ): Promise<Array<{ id: string; name: string }>> {
    if (permissionIds.length === 0) return [];

    const permissions = await this.prisma.permission.findMany({
      where: { id: { in: permissionIds } },
      select: { id: true, name: true, scope: true },
    });
    if (permissions.length !== permissionIds.length) {
      throw Errors.badRequest('One or more permissionIds do not exist');
    }

    const mismatched = permissions.filter(
      (permission) => (permission.scope as RoleScope) !== scope,
    );
    if (mismatched.length > 0) {
      throw Errors.badRequest(
        `A ${scope} role cannot hold ${mismatched[0].scope} permission "${mismatched[0].name}"`,
      );
    }
    return permissions;
  }
}
