import { Injectable } from '@nestjs/common';
import { DeviceToken, Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { Errors } from '../../common/errors/errors';
import { buildOrderBy, MetaQueryDto } from '../../common/dto/meta-query.dto';
import { PaginationMeta } from '../../common/dto/paginated-response.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateDeviceTokenDto } from './dto/create-device-token.dto';
import { UpdateDeviceTokenDto } from './dto/update-device-token.dto';

@Injectable()
export class DeviceTokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async create(
    dto: CreateDeviceTokenDto,
    actorId: string | null,
  ): Promise<DeviceToken> {
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

  findAll(query: MetaQueryDto = new MetaQueryDto()): Promise<DeviceToken[]> {
    return this.prisma.deviceToken.findMany(this.buildListArgs(query));
  }

  async findPaginated(
    query: MetaQueryDto,
  ): Promise<{ data: DeviceToken[]; meta: PaginationMeta }> {
    const { page, perPage } = query;
    const args = this.buildListArgs(query);
    const [data, total] = await this.prisma.$transaction([
      this.prisma.deviceToken.findMany({
        ...args,
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.deviceToken.count(),
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

  async findById(id: string): Promise<DeviceToken> {
    const row = await this.findByIdOrNull(id);
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
    actorId: string | null,
  ): Promise<DeviceToken> {
    await this.findById(id);
    const data: Prisma.DeviceTokenUpdateInput = {
      token: dto.token,
      appPlatform: dto.appPlatform,
      deviceType: dto.deviceType,
      deviceOs: dto.deviceOs,
      deviceOsVersion: dto.deviceOsVersion,
      updatedBy: actorId,
    };
    if (dto.userId !== undefined) {
      data.user = { connect: { id: dto.userId } };
    }
    const updated = await this.prisma.deviceToken.update({
      where: { id },
      data,
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

  async remove(id: string, actorId: string | null): Promise<void> {
    const existing = await this.findById(id);
    await this.prisma.deviceToken.delete({ where: { id } });
    if (actorId) {
      await this.auditService.record({
        action: 'device_token.deleted',
        actorId,
        targetUserId: existing.userId,
        metadata: { deviceTokenId: id },
      });
    }
  }
}
