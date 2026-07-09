import { Injectable } from '@nestjs/common';
import { Business, Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import type { AppAbility } from '../../common/authorization/app-ability';
import { buildOrderBy, MetaQueryDto } from '../../common/dto/meta-query.dto';
import { PaginationMeta } from '../../common/dto/paginated-response.dto';
import { SeededRoleName } from '../../common/enums/seeded-role-name.enum';
import { Errors } from '../../common/errors/errors';
import { buildAuditSnapshot } from '../../common/util/audit-snapshot.util';
import { PrismaService } from '../../prisma/prisma.service';
import { AbilityScopedQueryService } from '../authorization/ability-scoped-query.service';
import { PermissionCheckService } from '../authorization/permission-check.service';
import { PermissionLoaderService } from '../authorization/permission-loader.service';
import { CreateBusinessDto } from './dto/create-business.dto';
import { UpdateBusinessDto } from './dto/update-business.dto';

@Injectable()
export class BusinessesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly abilityScopedQueryService: AbilityScopedQueryService,
    private readonly permissionCheckService: PermissionCheckService,
    private readonly permissionLoaderService: PermissionLoaderService,
  ) {}

  /**
   * Creates a business and makes the creator its owner, atomically.
   *
   * A business without an owner is unadministrable — nobody could add members
   * or delete it — so the two writes are one transaction. `create Business` is
   * a PLATFORM permission held by every registered user (via PLATFORM_USER);
   * the BUSINESS_OWNER row is what grants authority *inside* the new business.
   */
  async create(dto: CreateBusinessDto, actorId: string): Promise<Business> {
    // `slug` is unique only among live rows (partial index), so a soft-deleted
    // business releases its slug. Check the live set explicitly rather than
    // relying on P2002, whose message would not distinguish the two cases.
    const slugTaken = await this.prisma.scoped.business.findFirst({
      where: { slug: dto.slug },
      select: { id: true },
    });
    if (slugTaken) {
      throw Errors.uniqueConstraintViolation('slug');
    }

    const business = await this.prisma.$transaction(async (transaction) => {
      const created = await transaction.business.create({
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
        where: { name: SeededRoleName.BUSINESS_OWNER },
        select: { id: true },
      });
      await transaction.businessMember.create({
        data: {
          businessId: created.id,
          userId: actorId,
          roleId: ownerRole.id,
          createdBy: actorId,
          updatedBy: actorId,
        },
      });

      return created;
    });

    // The creator's authorization just changed — they now hold BUSINESS_OWNER
    // in a business that did not exist a moment ago. Drop their cached grants
    // so the very next request sees it.
    await this.permissionLoaderService.invalidateUser(actorId);

    await this.auditService.record({
      action: 'business.created',
      actorId,
      metadata: { businessId: business.id, slug: business.slug },
    });
    return business;
  }

  // Lists only the businesses the caller may `read`: their own memberships,
  // or every business for a platform admin (`manage all` widens the filter to
  // nothing). No `@RequirePermission(..., { administrative: true })` needed —
  // the query does the scoping.
  async findPaginated(
    query: MetaQueryDto,
    ability: AppAbility,
  ): Promise<{ data: Business[]; meta: PaginationMeta }> {
    const { page, perPage } = query;
    // `buildWhereOrEmpty`, not `buildWhere`: a user who belongs to no business
    // sees an empty page, not a 403.
    const where = this.abilityScopedQueryService.buildWhereOrEmpty(
      ability,
      'read',
      'Business',
      this.buildSearchFilter(query),
    );
    const [data, total] = await this.prisma.$transaction([
      this.prisma.scoped.business.findMany({
        where,
        orderBy: buildOrderBy(
          query,
          ['createdAt', 'updatedAt', 'name', 'slug'] as const,
          'createdAt',
        ),
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.scoped.business.count({ where }),
    ]);
    return {
      data,
      meta: { page, perPage, total, totalPages: Math.ceil(total / perPage) },
    };
  }

  private buildSearchFilter(query: MetaQueryDto): Prisma.BusinessWhereInput {
    if (!query.search) return {};
    return {
      OR: [
        { name: { contains: query.search, mode: 'insensitive' } },
        { slug: { contains: query.search, mode: 'insensitive' } },
      ],
    };
  }

  /**
   * Loads a business the caller may READ, else 404.
   *
   * Visibility and permission are two different questions, and they deserve
   * two different answers:
   *
   *   - cannot READ it       → 404. A 403 would confirm the business exists,
   *                            which across a tenant boundary is itself a leak.
   *   - can read, cannot act → 403, via `assertMayAct`. The caller already sees
   *                            this business through `GET`; telling them it
   *                            "does not exist" when they try to edit it would
   *                            be a lie, and a confusing one.
   *
   * `…OrEmpty` so a caller holding NO grant on Business gets the same 404 as
   * one holding grants on *other* businesses — otherwise the status code would
   * reveal whether the caller belongs to any business at all.
   */
  async findById(id: string, ability: AppAbility): Promise<Business> {
    const business = await this.prisma.scoped.business.findFirst({
      where: this.abilityScopedQueryService.buildRecordWhereOrEmpty(
        ability,
        'read',
        'Business',
        id,
      ),
    });
    if (!business) {
      throw Errors.resourceNotFound('Business');
    }
    return business;
  }

  // The caller can see this business. May they do THIS to it? An instance
  // check, because the verdict depends on the record's own tenant.
  private assertMayAct(
    ability: AppAbility,
    action: 'update' | 'delete',
    business: Business,
  ): void {
    this.permissionCheckService.assertCan(ability, action, 'Business', {
      id: business.id,
    });
  }

  async update(
    id: string,
    dto: UpdateBusinessDto,
    ability: AppAbility,
    actorId: string,
  ): Promise<Business> {
    const existing = await this.findById(id, ability);
    this.assertMayAct(ability, 'update', existing);

    if (dto.slug) {
      const slugTaken = await this.prisma.scoped.business.findFirst({
        where: { slug: dto.slug, id: { not: id } },
        select: { id: true },
      });
      if (slugTaken) {
        throw Errors.uniqueConstraintViolation('slug');
      }
    }

    const updated = await this.prisma.business.update({
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
      action: 'business.updated',
      actorId,
      metadata: { businessId: id },
    });
    return updated;
  }

  // Soft delete. `business_members` rows are left in place: the membership is
  // history, and a restore (clearing `deletedAt`) must bring the roster back
  // with it. The scoped client hides the business from every read.
  async remove(
    id: string,
    ability: AppAbility,
    actorId: string,
  ): Promise<void> {
    const existing = await this.findById(id, ability);
    this.assertMayAct(ability, 'delete', existing);
    await this.prisma.business.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: actorId },
    });
    await this.auditService.record({
      action: 'business.soft_deleted',
      actorId,
      // Snapshot what it WAS. Soft delete hides the row; only the audit trail
      // records its state at the moment of deletion.
      metadata: { businessId: id, snapshot: buildAuditSnapshot(existing) },
    });
  }
}
