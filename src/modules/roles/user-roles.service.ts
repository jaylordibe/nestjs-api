import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { AppAbility } from '../../common/authorization/app-ability';
import { RoleScope } from '../../common/enums/role-scope.enum';
import { SeededRoleName } from '../../common/enums/seeded-role-name.enum';
import { Errors } from '../../common/errors/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionLoaderService } from '../authorization/permission-loader.service';

// A principal with no platform role has no authority to delegate. Note this
// is the OPPOSITE default from `BusinessMembersService`, where an absent
// membership row means "platform admin, unbounded". Here an absent role means
// "nothing" — every real user holds PLATFORM_USER.
const NO_AUTHORITY_RANK = 0;

// Grants and revokes PLATFORM-scope roles. Business roles are never assigned
// here — they live in `business_members`, and the database rejects a business
// role in `user_roles` outright (composite FK + CHECK constraint).
@Injectable()
export class UserRolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly permissionLoaderService: PermissionLoaderService,
  ) {}

  async assign(
    userId: string,
    roleId: string,
    ability: AppAbility,
    actorId: string,
  ): Promise<void> {
    const targetUser = await this.prisma.scoped.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!targetUser) {
      throw Errors.resourceNotFound('User');
    }

    const role = await this.loadPlatformRole(roleId);
    await this.assertMayAssignRank(actorId, role.rank, ability);

    await this.prisma.userRole.upsert({
      where: { userId_roleId: { userId, roleId } },
      create: { userId, roleId, createdBy: actorId },
      update: {},
    });

    await this.permissionLoaderService.invalidateUser(userId);
    await this.auditService.record({
      action: 'user.role_assigned',
      actorId,
      targetUserId: userId,
      metadata: { roleId, roleName: role.name },
    });
  }

  async revoke(
    userId: string,
    roleId: string,
    ability: AppAbility,
    actorId: string,
  ): Promise<void> {
    const role = await this.loadPlatformRole(roleId);
    await this.assertMayAssignRank(actorId, role.rank, ability);

    // PLATFORM_USER carries every self-service grant. Revoking it would leave
    // an account that cannot read its own profile — broken, not restricted.
    // Deactivate or delete the user instead.
    if ((role.name as SeededRoleName) === SeededRoleName.PLATFORM_USER) {
      throw Errors.resourceConflict(
        "PLATFORM_USER cannot be revoked — it carries the account's self-service permissions. " +
          'Deactivate or delete the user instead.',
      );
    }

    const existing = await this.prisma.userRole.findUnique({
      where: { userId_roleId: { userId, roleId } },
      select: { id: true },
    });
    if (!existing) {
      throw Errors.resourceNotFound('Role assignment');
    }

    await this.prisma.userRole.delete({ where: { id: existing.id } });
    await this.permissionLoaderService.invalidateUser(userId);
    await this.auditService.record({
      action: 'user.role_revoked',
      actorId,
      targetUserId: userId,
      metadata: { roleId, roleName: role.name },
    });
  }

  private async loadPlatformRole(roleId: string) {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      select: { id: true, name: true, rank: true, scope: true },
    });
    if (!role) {
      throw Errors.resourceNotFound('Role');
    }
    if ((role.scope as RoleScope) !== RoleScope.PLATFORM) {
      throw Errors.badRequest(
        'Only platform-scoped roles can be assigned to a user account. ' +
          'Business roles are granted by adding the user to a business.',
      );
    }
    return role;
  }

  // Same ceiling as inside a business: you may grant a role at or below your
  // own platform rank, never above it. Prevents a custom staff role that holds
  // `assignRole User` from minting a PLATFORM_ADMIN.
  private async assertMayAssignRank(
    actorId: string,
    targetRank: number,
    ability: AppAbility,
  ): Promise<void> {
    if (ability.can('manage', 'all')) return;

    const actorRoles = await this.prisma.userRole.findMany({
      where: { userId: actorId },
      select: { role: { select: { rank: true } } },
    });
    const actorRank = actorRoles.length
      ? Math.max(...actorRoles.map((userRole) => userRole.role.rank))
      : NO_AUTHORITY_RANK;

    if (targetRank > actorRank) {
      throw Errors.permissionDenied('assignRole', 'User');
    }
  }
}
