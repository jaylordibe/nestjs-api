import { Injectable } from '@nestjs/common';
import { AppVersion, Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { Errors } from '../../common/errors/errors';
import { buildOrderBy, MetaQueryDto } from '../../common/dto/meta-query.dto';
import { PaginationMeta } from '../../common/dto/paginated-response.dto';
import { AppPlatform } from '../../common/enums/app-platform.enum';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateAppVersionDto } from './dto/create-app-version.dto';
import { UpdateAppVersionDto } from './dto/update-app-version.dto';

@Injectable()
export class AppVersionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async create(
    dto: CreateAppVersionDto,
    actorId: string | null,
  ): Promise<AppVersion> {
    const created = await this.prisma.appVersion.create({
      data: {
        version: dto.version,
        description: dto.description,
        platform: dto.platform,
        releaseDate: dto.releaseDate,
        downloadUrl: dto.downloadUrl,
        forceUpdate: dto.forceUpdate,
        createdBy: actorId,
        updatedBy: actorId,
      },
    });
    if (actorId) {
      await this.auditService.record({
        action: 'app_version.created',
        actorId,
        metadata: {
          appVersionId: created.id,
          platform: created.platform,
          version: created.version,
        },
      });
    }
    return created;
  }

  async findPaginated(
    query: MetaQueryDto,
  ): Promise<{ data: AppVersion[]; meta: PaginationMeta }> {
    const { page, perPage } = query;
    const args = this.buildListArgs(query);
    const [data, total] = await this.prisma.$transaction([
      this.prisma.appVersion.findMany({
        ...args,
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.appVersion.count(),
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
    orderBy: Prisma.AppVersionOrderByWithRelationInput;
  } {
    return {
      orderBy: buildOrderBy(
        query,
        ['releaseDate', 'createdAt', 'updatedAt'] as const,
        'releaseDate',
      ),
    };
  }

  async findById(id: string): Promise<AppVersion> {
    const row = await this.findByIdOrNull(id);
    if (!row) {
      throw Errors.resourceNotFound('App version');
    }
    return row;
  }

  async findLatestByPlatform(platform: AppPlatform): Promise<AppVersion> {
    // This table is a signal for the mobile app ("is there an update, and
    // is it forced?"), not a version history. A bad release gets deleted
    // and replaced — there's no "deactivate without deleting" workflow,
    // so no isActive filter is needed here.
    const row = await this.prisma.appVersion.findFirst({
      where: { platform },
      orderBy: { releaseDate: 'desc' },
    });
    if (!row) {
      throw Errors.resourceNotFound(
        'App version',
        `No app version found for platform "${platform}"`,
      );
    }
    return row;
  }

  findByIdOrNull(id: string): Promise<AppVersion | null> {
    return this.prisma.appVersion.findUnique({ where: { id } });
  }

  async update(
    id: string,
    dto: UpdateAppVersionDto,
    actorId: string | null,
  ): Promise<AppVersion> {
    await this.findById(id);
    const data: Prisma.AppVersionUpdateInput = {
      version: dto.version,
      description: dto.description,
      platform: dto.platform,
      releaseDate: dto.releaseDate,
      downloadUrl: dto.downloadUrl,
      forceUpdate: dto.forceUpdate,
      updatedBy: actorId,
    };
    const updated = await this.prisma.appVersion.update({
      where: { id },
      data,
    });
    if (actorId) {
      await this.auditService.record({
        action: 'app_version.updated',
        actorId,
        metadata: {
          appVersionId: id,
          platform: updated.platform,
          version: updated.version,
        },
      });
    }
    return updated;
  }

  async remove(id: string, actorId: string | null): Promise<void> {
    const existing = await this.findById(id);
    await this.prisma.appVersion.delete({ where: { id } });
    if (actorId) {
      await this.auditService.record({
        action: 'app_version.deleted',
        actorId,
        metadata: {
          appVersionId: id,
          platform: existing.platform,
          version: existing.version,
        },
      });
    }
  }
}
