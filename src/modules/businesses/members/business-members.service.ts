import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../../common/audit/audit.service';
import type { AppAbility } from '../../../common/authorization/app-ability';
import { buildOrderBy, MetaQueryDto } from '../../../common/dto/meta-query.dto';
import { PaginationMeta } from '../../../common/dto/paginated-response.dto';
import { RoleScope } from '../../../common/enums/role-scope.enum';
import { SeededRoleName } from '../../../common/enums/seeded-role-name.enum';
import { Errors } from '../../../common/errors/errors';
import { buildAuditSnapshot } from '../../../common/util/audit-snapshot.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionLoaderService } from '../../authorization/permission-loader.service';
import type { BusinessMemberRow } from './dto/business-member-response.dto';
import { AddBusinessMemberDto } from './dto/add-business-member.dto';
import { UpdateBusinessMemberDto } from './dto/update-business-member.dto';

// A platform admin has no membership row and therefore no rank inside any
// business. They outrank everyone, so their ceiling is unbounded.
const UNBOUNDED_RANK = Number.POSITIVE_INFINITY;

const MEMBER_INCLUDE = {
  user: { select: { id: true, email: true, firstName: true, lastName: true } },
  role: { select: { id: true, name: true, description: true, rank: true } },
} as const;

// `User` is soft-deletable, and the `prisma.scoped` extension only filters
// TOP-LEVEL reads — a nested `include` of a soft-deleted user would still return
// it. Prisma offers no `where` on a to-one include, so the deleted user is
// excluded by filtering the PARENT rows here. Every roster query composes this.
const MEMBER_OF_LIVE_USER = { user: { deletedAt: null } } as const;

@Injectable()
export class BusinessMembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly permissionLoaderService: PermissionLoaderService,
  ) {}

  /**
   * Adds an existing user to a business roster.
   *
   * The caller has already been proven a member of THIS business (or a
   * platform admin) by `PermissionsGuard`, which evaluates the tenant
   * condition against `:businessId`. What the guard cannot know is the *rank*
   * of the role being handed out — that check lives here.
   */
  async add(
    businessId: string,
    dto: AddBusinessMemberDto,
    ability: AppAbility,
    actorId: string,
  ): Promise<BusinessMemberRow> {
    const targetUser = await this.prisma.scoped.user.findFirst({
      where: { email: dto.email },
      select: { id: true },
    });
    if (!targetUser) {
      throw Errors.resourceNotFound('User');
    }

    const targetRole = await this.loadAssignableRole(dto.roleId);
    await this.assertMayAssignRole(
      businessId,
      actorId,
      targetRole.rank,
      ability,
    );

    const existing = await this.prisma.businessMember.findUnique({
      where: { businessId_userId: { businessId, userId: targetUser.id } },
      select: { id: true },
    });
    if (existing) {
      throw Errors.resourceConflict(
        'That user is already a member of this business',
      );
    }

    const member = await this.prisma.businessMember.create({
      data: {
        businessId,
        userId: targetUser.id,
        roleId: targetRole.id,
        createdBy: actorId,
        updatedBy: actorId,
      },
      include: MEMBER_INCLUDE,
    });

    // The new member's authority changed; drop their cached grants.
    await this.permissionLoaderService.invalidateUser(targetUser.id);
    await this.auditService.record({
      action: 'business_member.added',
      actorId,
      targetUserId: targetUser.id,
      metadata: {
        businessId,
        roleId: targetRole.id,
        roleName: targetRole.name,
      },
    });
    return member;
  }

  async findPaginated(
    businessId: string,
    query: MetaQueryDto,
  ): Promise<{ data: BusinessMemberRow[]; meta: PaginationMeta }> {
    const { page, perPage } = query;
    // No ability filter needed: the guard already proved the caller may read
    // this business's roster, and `businessId` fully scopes the query.
    const where: Prisma.BusinessMemberWhereInput = {
      businessId,
      ...MEMBER_OF_LIVE_USER,
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.businessMember.findMany({
        where,
        include: MEMBER_INCLUDE,
        orderBy: buildOrderBy(
          query,
          ['createdAt', 'updatedAt'] as const,
          'createdAt',
        ),
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.businessMember.count({ where }),
    ]);
    return {
      data,
      meta: { page, perPage, total, totalPages: Math.ceil(total / perPage) },
    };
  }

  async findById(
    businessId: string,
    memberId: string,
  ): Promise<BusinessMemberRow> {
    const member = await this.prisma.businessMember.findFirst({
      where: { id: memberId, businessId, ...MEMBER_OF_LIVE_USER },
      include: MEMBER_INCLUDE,
    });
    if (!member) {
      throw Errors.resourceNotFound('Business member');
    }
    return member;
  }

  /**
   * Changes a member's role.
   *
   * Two invariants, both enforced inside a serializable transaction so
   * concurrent writes cannot slip between the check and the write:
   *   1. the rank guard — you may not grant a role at or above your own;
   *   2. the last-owner invariant — a business always has an owner.
   */
  async changeRole(
    businessId: string,
    memberId: string,
    dto: UpdateBusinessMemberDto,
    ability: AppAbility,
    actorId: string,
  ): Promise<BusinessMemberRow> {
    const targetRole = await this.loadAssignableRole(dto.roleId);
    await this.assertMayAssignRole(
      businessId,
      actorId,
      targetRole.rank,
      ability,
    );

    const member = await this.prisma.$transaction(
      async (transaction) => {
        const existing = await transaction.businessMember.findFirst({
          where: { id: memberId, businessId },
          include: { role: { select: { name: true, rank: true } } },
        });
        if (!existing) {
          throw Errors.resourceNotFound('Business member');
        }

        // You may not demote (or promote) someone who outranks you.
        await this.assertMayAssignRole(
          businessId,
          actorId,
          existing.role.rank,
          ability,
        );

        // DB columns are plain `String`; cast at the boundary before comparing
        // against the TS enum (`no-unsafe-enum-comparison`).
        const currentRoleName = existing.role.name as SeededRoleName;
        const nextRoleName = targetRole.name as SeededRoleName;
        const isDemotingAnOwner =
          currentRoleName === SeededRoleName.BUSINESS_OWNER &&
          nextRoleName !== SeededRoleName.BUSINESS_OWNER;
        if (isDemotingAnOwner) {
          await this.assertNotLastOwner(transaction, businessId);
        }

        return transaction.businessMember.update({
          where: { id: memberId },
          data: { roleId: targetRole.id, updatedBy: actorId },
          include: MEMBER_INCLUDE,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.permissionLoaderService.invalidateUser(member.userId);
    await this.auditService.record({
      action: 'business_member.role_changed',
      actorId,
      targetUserId: member.userId,
      metadata: {
        businessId,
        roleId: targetRole.id,
        roleName: targetRole.name,
      },
    });
    return member;
  }

  async remove(
    businessId: string,
    memberId: string,
    ability: AppAbility,
    actorId: string,
  ): Promise<void> {
    const removed = await this.prisma.$transaction(
      async (transaction) => {
        const existing = await transaction.businessMember.findFirst({
          where: { id: memberId, businessId },
          include: { role: { select: { name: true, rank: true } } },
        });
        if (!existing) {
          throw Errors.resourceNotFound('Business member');
        }

        // You may not remove someone who outranks you (or your equal).
        await this.assertMayAssignRole(
          businessId,
          actorId,
          existing.role.rank,
          ability,
        );

        if (
          (existing.role.name as SeededRoleName) ===
          SeededRoleName.BUSINESS_OWNER
        ) {
          await this.assertNotLastOwner(transaction, businessId);
        }

        await transaction.businessMember.delete({ where: { id: memberId } });
        return {
          userId: existing.userId,
          snapshot: buildAuditSnapshot(existing),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.permissionLoaderService.invalidateUser(removed.userId);
    await this.auditService.record({
      action: 'business_member.removed',
      actorId,
      targetUserId: removed.userId,
      // Hard delete: the audit trail is the ONLY record this membership existed.
      metadata: { businessId, snapshot: removed.snapshot },
    });
  }

  // ── invariants ─────────────────────────────────────────────────────────

  private async loadAssignableRole(roleId: string) {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      select: { id: true, name: true, rank: true, scope: true },
    });
    if (!role) {
      throw Errors.resourceNotFound('Role');
    }
    // The database would reject this too (composite FK + CHECK), but a clean
    // 400 beats a foreign-key error surfacing as FK_REFERENCE_INVALID.
    if ((role.scope as RoleScope) !== RoleScope.BUSINESS) {
      throw Errors.badRequest(
        'Only business-scoped roles can be assigned inside a business',
      );
    }
    return role;
  }

  /**
   * The privilege-escalation guard.
   *
   * `assignRole` permission alone is not enough: a BUSINESS_ADMIN who may
   * assign roles could otherwise assign BUSINESS_OWNER — to itself. The
   * ceiling is the actor's own rank in this business:
   *
   *   you may grant, or act upon, a role AT OR BELOW your own rank,
   *   never one ABOVE it.
   *
   * At-or-below (rather than strictly-below) is deliberate. A lateral grant is
   * not an escalation — a BUSINESS_ADMIN creating a peer BUSINESS_ADMIN gains
   * nothing it did not already have. And strictly-below would make a co-owner
   * impossible to appoint, which would in turn make `assertNotLastOwner`'s
   * advice ("promote another member first") unreachable. What is forbidden is
   * reaching UP: an admin can never mint an owner.
   *
   * A platform admin has no membership row here and is unbounded — they were
   * already granted `manage all`.
   *
   * `rank` orders roles for this check ONLY. It does not imply inherited
   * permissions; each role's grants are listed explicitly in the catalog.
   */
  private async assertMayAssignRole(
    businessId: string,
    actorId: string,
    targetRank: number,
    ability: AppAbility,
  ): Promise<void> {
    if (ability.can('manage', 'all')) return;

    const actorMembership = await this.prisma.businessMember.findUnique({
      where: { businessId_userId: { businessId, userId: actorId } },
      select: { role: { select: { rank: true } } },
    });
    const actorRank = actorMembership?.role.rank ?? UNBOUNDED_RANK;

    if (targetRank > actorRank) {
      throw Errors.permissionDenied('assignRole', 'BusinessMember');
    }
  }

  // A business must always have at least one owner, or it becomes
  // unadministrable: nobody could add members, or delete it. Checked inside
  // the caller's serializable transaction so two concurrent demotions cannot
  // both observe "there are 2 owners" and race the business down to zero.
  private async assertNotLastOwner(
    transaction: Prisma.TransactionClient,
    businessId: string,
  ): Promise<void> {
    const ownerCount = await transaction.businessMember.count({
      where: { businessId, role: { name: SeededRoleName.BUSINESS_OWNER } },
    });
    if (ownerCount <= 1) {
      throw Errors.resourceConflict(
        'A business must always have at least one owner. Promote another member first.',
      );
    }
  }
}
