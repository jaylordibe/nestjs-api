import { Injectable } from '@nestjs/common';
import { AuditService } from '../../../common/audit/audit.service';
import type { AppAbility } from '../../../common/authorization/app-ability';
import { buildOrderBy, MetaQueryDto } from '../../../common/dto/meta-query.dto';
import { PaginationMeta } from '../../../common/dto/paginated-response.dto';
import { Errors } from '../../../common/errors/errors';
import { buildAuditSnapshot } from '../../../common/util/audit-snapshot.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { AbilityScopedQueryService } from '../../authorization/ability-scoped-query.service';
import { PermissionCheckService } from '../../authorization/permission-check.service';
import { AddBusinessCustomerDto } from './dto/add-business-customer.dto';
import type { BusinessCustomerRow } from './dto/business-customer-response.dto';
import { UpdateBusinessCustomerDto } from './dto/update-business-customer.dto';

const CUSTOMER_INCLUDE = {
  user: { select: { id: true, email: true, firstName: true, lastName: true } },
} as const;

// Same reason as the roster: `prisma.scoped` cannot filter a nested `include`,
// and Prisma has no `where` on a to-one include. Exclude customers whose user
// account has been soft-deleted by filtering the parent rows.
const CUSTOMER_OF_LIVE_USER = { user: { deletedAt: null } } as const;

/**
 * A customer's relationship with a business.
 *
 * `BusinessCustomer` is the first subject that is both **ownable** (the
 * customer, via `userId`) and **tenant-scoped** (the business, via
 * `businessId`). The two rules OR-compose, so one query serves both audiences:
 *
 *   - a customer sees only their own record in this business;
 *   - staff see every customer record in their tenant;
 *   - a platform admin (`manage all`) sees everything.
 *
 * No new machinery — `AbilityScopedQueryService` handles it.
 */
@Injectable()
export class BusinessCustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly abilityScopedQueryService: AbilityScopedQueryService,
    private readonly permissionCheckService: PermissionCheckService,
  ) {}

  /**
   * Registers a customer.
   *
   * With no `email`, the caller enrols themselves — the self-join path every
   * user holds via `create BusinessCustomer (own)`.
   *
   * With an `email`, the caller enrols someone else, which their own-scoped
   * rule cannot satisfy: the instance check below runs against the RESOLVED
   * target's `userId`, so only a rule scoped to the business (staff) matches.
   * The guard could not make this distinction — it had no target to check.
   */
  async add(
    businessId: string,
    dto: AddBusinessCustomerDto,
    ability: AppAbility,
    actorId: string,
  ): Promise<BusinessCustomerRow> {
    const targetUserId = dto.email
      ? await this.resolveUserIdByEmail(dto.email)
      : actorId;

    this.permissionCheckService.assertCan(
      ability,
      'create',
      'BusinessCustomer',
      {
        businessId,
        userId: targetUserId,
      },
    );

    // `notes` is a staff annotation. A self-joining customer must not be able
    // to write it, so it is only accepted from a caller who could update the
    // record anyway.
    const mayAnnotate = ability.can('update', 'BusinessCustomer');
    if (dto.notes !== undefined && !mayAnnotate) {
      throw Errors.permissionDenied('update', 'BusinessCustomer');
    }

    // The business must exist and be visible to the caller. Without this, a
    // POST to a random businessId would create an orphan-ish row (the FK would
    // catch a nonexistent id, but a soft-deleted business would not).
    const business = await this.prisma.scoped.business.findFirst({
      where: { id: businessId },
      select: { id: true },
    });
    if (!business) {
      throw Errors.resourceNotFound('Business');
    }

    const existing = await this.prisma.businessCustomer.findUnique({
      where: { businessId_userId: { businessId, userId: targetUserId } },
      select: { id: true },
    });
    if (existing) {
      throw Errors.resourceConflict(
        'That user is already a customer of this business',
      );
    }

    const customer = await this.prisma.businessCustomer.create({
      data: {
        businessId,
        userId: targetUserId,
        notes: mayAnnotate ? dto.notes : undefined,
        createdBy: actorId,
        updatedBy: actorId,
      },
      include: CUSTOMER_INCLUDE,
    });

    await this.auditService.record({
      action: 'business_customer.added',
      actorId,
      targetUserId,
      metadata: { businessId, selfJoined: targetUserId === actorId },
    });
    return customer;
  }

  // Scoped by the ability: staff get the whole tenant, a customer gets their
  // own row, and a stranger gets an empty page rather than a 403.
  async findPaginated(
    businessId: string,
    query: MetaQueryDto,
    ability: AppAbility,
  ): Promise<{ data: BusinessCustomerRow[]; meta: PaginationMeta }> {
    const { page, perPage } = query;
    const where = this.abilityScopedQueryService.buildWhereOrEmpty(
      ability,
      'read',
      'BusinessCustomer',
      { businessId, ...CUSTOMER_OF_LIVE_USER },
    );
    const [data, total] = await this.prisma.$transaction([
      this.prisma.businessCustomer.findMany({
        where,
        include: CUSTOMER_INCLUDE,
        orderBy: buildOrderBy(
          query,
          ['createdAt', 'updatedAt'] as const,
          'createdAt',
        ),
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.businessCustomer.count({ where }),
    ]);
    return {
      data,
      meta: { page, perPage, total, totalPages: Math.ceil(total / perPage) },
    };
  }

  // A record the caller may not read is simply not found — never 403.
  async findById(
    businessId: string,
    customerId: string,
    ability: AppAbility,
  ): Promise<BusinessCustomerRow> {
    const where = this.abilityScopedQueryService.buildWhereOrEmpty(
      ability,
      'read',
      'BusinessCustomer',
      { id: customerId, businessId, ...CUSTOMER_OF_LIVE_USER },
    );
    const customer = await this.prisma.businessCustomer.findFirst({
      where,
      include: CUSTOMER_INCLUDE,
    });
    if (!customer) {
      throw Errors.resourceNotFound('Business customer');
    }
    return customer;
  }

  async update(
    businessId: string,
    customerId: string,
    dto: UpdateBusinessCustomerDto,
    ability: AppAbility,
    actorId: string,
  ): Promise<BusinessCustomerRow> {
    // Visible first (404), then permitted (403). A customer can read their own
    // record but may not annotate it.
    const existing = await this.findById(businessId, customerId, ability);
    this.permissionCheckService.assertCan(
      ability,
      'update',
      'BusinessCustomer',
      {
        businessId: existing.businessId,
        userId: existing.userId,
      },
    );

    const updated = await this.prisma.businessCustomer.update({
      where: { id: customerId },
      data: { notes: dto.notes, isActive: dto.isActive, updatedBy: actorId },
      include: CUSTOMER_INCLUDE,
    });
    await this.auditService.record({
      action: 'business_customer.updated',
      actorId,
      targetUserId: existing.userId,
      metadata: { businessId, businessCustomerId: customerId },
    });
    return updated;
  }

  // A customer may end their own relationship; staff may remove anyone's.
  async remove(
    businessId: string,
    customerId: string,
    ability: AppAbility,
    actorId: string,
  ): Promise<void> {
    const existing = await this.findById(businessId, customerId, ability);
    this.permissionCheckService.assertCan(
      ability,
      'delete',
      'BusinessCustomer',
      {
        businessId: existing.businessId,
        userId: existing.userId,
      },
    );

    await this.prisma.businessCustomer.delete({ where: { id: customerId } });
    await this.auditService.record({
      action: 'business_customer.removed',
      actorId,
      targetUserId: existing.userId,
      // Hard delete: the audit trail is the ONLY record this relationship existed.
      metadata: {
        businessId,
        selfRemoved: existing.userId === actorId,
        snapshot: buildAuditSnapshot(existing),
      },
    });
  }

  private async resolveUserIdByEmail(email: string): Promise<string> {
    // `findFirst`: email is unique only among live rows (partial index).
    const user = await this.prisma.scoped.user.findFirst({
      where: { email },
      select: { id: true },
    });
    if (!user) {
      throw Errors.resourceNotFound('User');
    }
    return user.id;
  }
}
