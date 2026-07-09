import { Injectable } from '@nestjs/common';
import { DeviceToken, Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import type { AppAbility } from '../../common/authorization/app-ability';
import { Errors } from '../../common/errors/errors';
import { buildOrderBy, MetaQueryDto } from '../../common/dto/meta-query.dto';
import { PaginationMeta } from '../../common/dto/paginated-response.dto';
import { AbilityScopedQueryService } from '../authorization/ability-scoped-query.service';
import { PermissionCheckService } from '../authorization/permission-check.service';
import { buildAuditSnapshot } from '../../common/util/audit-snapshot.util';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateDeviceTokenDto } from './dto/create-device-token.dto';
import { UpdateDeviceTokenDto } from './dto/update-device-token.dto';

// Device tokens are owned by a user. A holder of `manage DeviceToken (own)`
// (i.e. every registered user, via PLATFORM_USER) may manage their own; a
// platform admin may manage anyone's.
//
// The guard cannot tell those apart — it only knows a rule exists — so
// ownership is enforced here: reads and writes go through an ability-scoped
// `where`, so another user's token is never loaded and the caller gets a 404
// rather than a 403 that would confirm the token exists.
@Injectable()
export class DeviceTokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly abilityScopedQueryService: AbilityScopedQueryService,
    private readonly permissionCheckService: PermissionCheckService,
  ) {}

  async create(
    dto: CreateDeviceTokenDto,
    ability: AppAbility,
    actorId: string | null,
  ): Promise<DeviceToken> {
    // No record exists yet, so scope by the record the caller is asking us to
    // build. A user with `manage (own)` may only name themselves as owner.
    this.permissionCheckService.assertCan(ability, 'create', 'DeviceToken', {
      userId: dto.userId,
    });

    const created = await this.prisma.deviceToken.create({
      data: {
        userId: dto.userId,
        token: dto.token,
        appPlatform: dto.appPlatform,
        deviceType: dto.deviceType,
        deviceOs: dto.deviceOs,
        deviceOsVersion: dto.deviceOsVersion,
        createdBy: actorId,
        updatedBy: actorId,
      },
    });
    if (actorId) {
      await this.auditService.record({
        action: 'device_token.created',
        actorId,
        targetUserId: created.userId,
        metadata: { deviceTokenId: created.id },
      });
    }
    return created;
  }

  async findPaginated(
    query: MetaQueryDto,
    ability: AppAbility,
  ): Promise<{ data: DeviceToken[]; meta: PaginationMeta }> {
    const { page, perPage } = query;
    const where = this.abilityScopedQueryService.buildWhere(
      ability,
      'read',
      'DeviceToken',
    );
    const args = this.buildListArgs(query);
    const [data, total] = await this.prisma.$transaction([
      this.prisma.deviceToken.findMany({
        ...args,
        where,
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      // Count the same scoped set the page was drawn from, or `total` would
      // describe rows the caller cannot see.
      this.prisma.deviceToken.count({ where }),
    ]);
    return {
      data,
      meta: {
        page,
        perPage,
        total,
        totalPages: Math.ceil(total / perPage),
      },
    };
  }

  private buildListArgs(query: MetaQueryDto): {
    orderBy: Prisma.DeviceTokenOrderByWithRelationInput;
  } {
    return {
      orderBy: buildOrderBy(
        query,
        ['createdAt', 'updatedAt'] as const,
        'createdAt',
      ),
    };
  }

  // `action` decides which rows are reachable: a caller may be able to `read`
  // a token they cannot `delete`. Unreachable rows are simply not found.
  async findById(
    id: string,
    ability: AppAbility,
    action: 'read' | 'update' | 'delete' = 'read',
  ): Promise<DeviceToken> {
    const row = await this.prisma.deviceToken.findFirst({
      where: this.abilityScopedQueryService.buildRecordWhere(
        ability,
        action,
        'DeviceToken',
        id,
      ),
    });
    if (!row) {
      throw Errors.resourceNotFound('Device token');
    }
    return row;
  }

  findByIdOrNull(id: string): Promise<DeviceToken | null> {
    return this.prisma.deviceToken.findUnique({ where: { id } });
  }

  async update(
    id: string,
    dto: UpdateDeviceTokenDto,
    ability: AppAbility,
    actorId: string | null,
  ): Promise<DeviceToken> {
    await this.findById(id, ability, 'update');

    const updateData: Prisma.DeviceTokenUpdateInput = {
      token: dto.token,
      appPlatform: dto.appPlatform,
      deviceType: dto.deviceType,
      deviceOs: dto.deviceOs,
      deviceOsVersion: dto.deviceOsVersion,
      updatedBy: actorId,
    };
    if (dto.userId !== undefined) {
      // Re-homing a token to another user is a write against THAT user's
      // records. Check the destination too, or a self-service caller could
      // hand their token to someone else.
      this.permissionCheckService.assertCan(ability, 'update', 'DeviceToken', {
        userId: dto.userId,
      });
      updateData.user = { connect: { id: dto.userId } };
    }

    const updated = await this.prisma.deviceToken.update({
      where: { id },
      data: updateData,
    });
    if (actorId) {
      await this.auditService.record({
        action: 'device_token.updated',
        actorId,
        targetUserId: updated.userId,
        metadata: { deviceTokenId: id },
      });
    }
    return updated;
  }

  async remove(
    id: string,
    ability: AppAbility,
    actorId: string | null,
  ): Promise<void> {
    const existing = await this.findById(id, ability, 'delete');
    await this.prisma.deviceToken.delete({ where: { id } });
    if (actorId) {
      await this.auditService.record({
        action: 'device_token.deleted',
        actorId,
        targetUserId: existing.userId,
        // `token` is stripped by the snapshot denylist — a push token is a
        // credential.
        metadata: { deviceTokenId: id, snapshot: buildAuditSnapshot(existing) },
      });
    }
  }
}
