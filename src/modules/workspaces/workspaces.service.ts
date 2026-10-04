import { Injectable } from '@nestjs/common';
import { Workspace, Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import type { AppAbility } from '../../common/authorization/app-ability';
import { buildOrderBy, MetaQueryDto } from '../../common/dto/meta-query.dto';
import { PaginationMeta } from '../../common/dto/paginated-response.dto';
import { WorkspaceMembershipStatus } from '../../common/enums/workspace-membership-status.enum';
import { SeededRoleName } from '../../common/enums/seeded-role-name.enum';
import { Errors } from '../../common/errors/errors';
import { buildAuditSnapshot } from '../../common/util/audit-snapshot.util';
import { PrismaService } from '../../prisma/prisma.service';
import { AbilityScopedQueryService } from '../authorization/ability-scoped-query.service';
import { PermissionCheckService } from '../authorization/permission-check.service';
import { PermissionLoaderService } from '../authorization/permission-loader.service';
import { WorkspaceOwnershipPolicy } from './workspace-ownership.policy';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly abilityScopedQueryService: AbilityScopedQueryService,
    private readonly permissionCheckService: PermissionCheckService,
    private readonly permissionLoaderService: PermissionLoaderService,
    private readonly workspaceOwnershipPolicy: WorkspaceOwnershipPolicy,
  ) {}

  /**
   * Creates a workspace and makes the creator its owner, atomically.
   *
   * A workspace without an owner is unadministrable — nobody could add members
   * or delete it — so the two writes are one transaction. `create Workspace` is
   * intrinsic to every authenticated caller; the WORKSPACE_OWNER membership is
   * what grants authority *inside* the new workspace.
   */
  async create(dto: CreateWorkspaceDto, actorId: string): Promise<Workspace> {
    // `slug` is unique only among live rows (partial index), so a soft-deleted
    // workspace releases its slug. Check the live set explicitly rather than
    // relying on P2002, whose message would not distinguish the two cases.
    const slugTaken = await this.prisma.scoped.workspace.findFirst({
      where: { slug: dto.slug },
      select: { id: true },
    });
    if (slugTaken) {
      throw Errors.uniqueConstraintViolation('slug');
    }

    const { workspace, membershipId } = await this.prisma.$transaction(
      async (transaction) => {
        // The founding owner's user row. No workspace row exists yet to lock, so
        // this is the only rendezvous point — and it is the one that matters: an
        // account being deleted concurrently must not come out of the race owning
        // a brand-new workspace nobody can administer.
        await this.workspaceOwnershipPolicy.assertUserMayHoldActiveMembership(
          transaction,
          actorId,
        );

        const created = await transaction.workspace.create({
          data: {
            name: dto.name,
            slug: dto.slug,
            description: dto.description,
            isActive: dto.isActive,
            createdBy: actorId,
            updatedBy: actorId,
          },
        });

        const ownerRole = await transaction.role.findUniqueOrThrow({
          where: { name: SeededRoleName.WORKSPACE_OWNER },
          select: { id: true },
        });
        const membership = await transaction.workspaceMembership.create({
          data: {
            workspaceId: created.id,
            userId: actorId,
            roleId: ownerRole.id,
            status: WorkspaceMembershipStatus.ACTIVE,
            // `joined_at` is NOT NULL, and the creator joins the instant the
            // workspace exists.
            joinedAt: new Date(),
            createdBy: actorId,
            updatedBy: actorId,
          },
          select: { id: true },
        });

        return { workspace: created, membershipId: membership.id };
      },
    );

    // The creator's authorization just changed — they now hold WORKSPACE_OWNER
    // in a workspace that did not exist a moment ago. Drop their cached grants
    // so the very next request sees it.
    await this.permissionLoaderService.invalidateUser(actorId);

    await this.auditService.record({
      action: 'workspace.created',
      actorId,
      metadata: { workspaceId: workspace.id, slug: workspace.slug },
    });
    // The founding membership is a JOIN, and audit events are this template's
    // membership history (see `WorkspaceMembership` in schema.prisma). Without
    // this row the one tenure that every workspace starts with — its owner's —
    // would be the only one with no recorded beginning.
    await this.auditService.record({
      action: 'workspace_membership.added',
      actorId,
      targetUserId: actorId,
      metadata: {
        workspaceId: workspace.id,
        membershipId,
        roleName: SeededRoleName.WORKSPACE_OWNER,
        isFoundingOwner: true,
        isRejoin: false,
      },
    });
    return workspace;
  }

  // Lists only the workspaces the caller may `read`: their own memberships,
  // or every workspace for a platform admin (`manage all` widens the filter to
  // nothing). No `@RequirePermission(..., { administrative: true })` needed —
  // the query does the scoping.
  async findPaginated(
    query: MetaQueryDto,
    ability: AppAbility,
  ): Promise<{ data: Workspace[]; meta: PaginationMeta }> {
    const { page, perPage } = query;
    // `buildWhereOrEmpty`, not `buildWhere`: a user who belongs to no workspace
    // sees an empty page, not a 403.
    const where = this.abilityScopedQueryService.buildWhereOrEmpty(
      ability,
      'read',
      'Workspace',
      this.buildSearchFilter(query),
    );
    const [data, total] = await this.prisma.$transaction([
      this.prisma.scoped.workspace.findMany({
        where,
        orderBy: buildOrderBy(
          query,
          ['createdAt', 'updatedAt', 'name', 'slug'] as const,
          'createdAt',
        ),
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.scoped.workspace.count({ where }),
    ]);
    return {
      data,
      meta: { page, perPage, total, totalPages: Math.ceil(total / perPage) },
    };
  }

  private buildSearchFilter(query: MetaQueryDto): Prisma.WorkspaceWhereInput {
    if (!query.search) return {};
    return {
      OR: [
        { name: { contains: query.search, mode: 'insensitive' } },
        { slug: { contains: query.search, mode: 'insensitive' } },
      ],
    };
  }

  /**
   * Loads a workspace the caller may READ, else 404.
   *
   * Visibility and permission are two different questions, and they deserve
   * two different answers:
   *
   *   - cannot READ it       → 404. A 403 would confirm the workspace exists,
   *                            which across a tenant boundary is itself a leak.
   *   - can read, cannot act → 403, via `assertMayAct`. The caller already sees
   *                            this workspace through `GET`; telling them it
   *                            "does not exist" when they try to edit it would
   *                            be a lie, and a confusing one.
   *
   * `…OrEmpty` so a caller holding NO grant on Workspace gets the same 404 as
   * one holding grants on *other* workspaces — otherwise the status code would
   * reveal whether the caller belongs to any workspace at all.
   */
  async findById(id: string, ability: AppAbility): Promise<Workspace> {
    const workspace = await this.prisma.scoped.workspace.findFirst({
      where: this.abilityScopedQueryService.buildRecordWhereOrEmpty(
        ability,
        'read',
        'Workspace',
        id,
      ),
    });
    if (!workspace) {
      throw Errors.resourceNotFound('Workspace');
    }
    return workspace;
  }

  // The caller can see this workspace. May they do THIS to it? An instance
  // check, because the verdict depends on the record's own tenant.
  private assertMayAct(
    ability: AppAbility,
    action: 'update' | 'delete',
    workspace: Workspace,
  ): void {
    this.permissionCheckService.assertCan(ability, action, 'Workspace', {
      id: workspace.id,
    });
  }

  async update(
    id: string,
    dto: UpdateWorkspaceDto,
    ability: AppAbility,
    actorId: string,
  ): Promise<Workspace> {
    const existing = await this.findById(id, ability);
    this.assertMayAct(ability, 'update', existing);

    if (dto.slug) {
      const slugTaken = await this.prisma.scoped.workspace.findFirst({
        where: { slug: dto.slug, id: { not: id } },
        select: { id: true },
      });
      if (slugTaken) {
        throw Errors.uniqueConstraintViolation('slug');
      }
    }

    const updated = await this.prisma.workspace.update({
      where: { id },
      data: {
        name: dto.name,
        slug: dto.slug,
        description: dto.description,
        isActive: dto.isActive,
        updatedBy: actorId,
      },
    });
    await this.auditService.record({
      action: 'workspace.updated',
      actorId,
      metadata: { workspaceId: id },
    });
    return updated;
  }

  // Soft delete. `workspace_memberships` rows are left in place: the membership
  // is history, and a restore (clearing `deletedAt`) must bring the roster back
  // with it. The scoped client hides the workspace from every read, and
  // `PermissionLoaderService` stops issuing its workspace-scoped grants.
  async remove(
    id: string,
    ability: AppAbility,
    actorId: string,
  ): Promise<void> {
    const existing = await this.findById(id, ability);
    this.assertMayAct(ability, 'delete', existing);

    // Read the roster BEFORE the delete: these are the users whose authority is
    // about to change. Every status, not just ACTIVE — a suspended member holds
    // no authority now, but a cached grant set written while they were active
    // could still be live, and this is the moment to retire it.
    const memberships = await this.prisma.workspaceMembership.findMany({
      where: { workspaceId: id },
      select: { userId: true },
    });

    await this.prisma.workspace.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: actorId },
    });

    // Everyone on the roster just lost their workspace-scoped grants. Grants are
    // cached per user, so each cached copy must be dropped — otherwise they keep
    // authority over a workspace nobody can see any more, until the TTL expires.
    //
    // This list is the whole roster, which a product may grow very large, and
    // this loop is serial. It is acceptable here because soft-deleting a
    // workspace is a rare, human-initiated action, not a hot path — but a
    // template that grows a bulk-tenant-deletion feature should move it to the
    // queue rather than let one request fan out unboundedly.
    for (const membership of memberships) {
      await this.permissionLoaderService.invalidateUser(membership.userId);
    }

    await this.auditService.record({
      action: 'workspace.soft_deleted',
      actorId,
      // Snapshot what it WAS. Soft delete hides the row; only the audit trail
      // records its state at the moment of deletion.
      metadata: { workspaceId: id, snapshot: buildAuditSnapshot(existing) },
    });
  }
}
