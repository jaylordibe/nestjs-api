import { Injectable } from '@nestjs/common';
import { AppVersion, Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { Errors } from '../../common/errors/errors';
import {
  buildOrderBy,
  MetaQueryDto,
  SortOrder,
} from '../../common/dto/meta-query.dto';
import { PaginationMeta } from '../../common/dto/paginated-response.dto';
import { AppPlatform } from '../../common/enums/app-platform.enum';
import { DeviceOs } from '../../common/enums/device-os.enum';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateAppVersionDto } from './dto/create-app-version.dto';
import { UpdateAppVersionDto } from './dto/update-app-version.dto';
import {
  isReleaseTrainOsForPlatform,
  isSingleDistributionPlatform,
  RELEASE_TRAIN_OS_BY_PLATFORM,
} from './release-train-registry';

const APP_VERSION_SORTABLE_COLUMNS = [
  'releaseDate',
  'version',
  'createdAt',
  'updatedAt',
] as const;

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
    const deviceOs = this.resolveDeviceOs(dto.platform, dto.deviceOs);
    await this.assertVersionAvailable(dto.platform, deviceOs, dto.version);
    const created = await this.prisma.appVersion.create({
      data: {
        version: dto.version,
        description: dto.description,
        platform: dto.platform,
        deviceOs,
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
          deviceOs: created.deviceOs,
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

  // Releases sort newest-first. DESC is passed explicitly rather than left to
  // `buildOrderBy`'s default: "the newest release comes first" is a property of
  // this endpoint, and a reader should not have to open another file to learn
  // it — nor should a future change to that default silently reverse this list.
  private buildListArgs(query: MetaQueryDto): {
    orderBy: Prisma.AppVersionOrderByWithRelationInput;
  } {
    return {
      orderBy: buildOrderBy(
        query,
        APP_VERSION_SORTABLE_COLUMNS,
        'releaseDate',
        SortOrder.DESC,
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

  async findLatest(
    platform: AppPlatform,
    deviceOs: DeviceOs | null,
  ): Promise<AppVersion> {
    // This table is a signal for the client ("is there an update, and is it
    // forced?"), not a version history. A bad release gets deleted and
    // replaced — there is no "deactivate without deleting" workflow, so no
    // isActive filter is needed here.
    //
    // `deviceOs` is part of the lookup rather than a refinement of it: a
    // multi-train platform resolves ITS OWN train, and `web` matches the single
    // null-OS row.
    const row = await this.prisma.appVersion.findFirst({
      where: { platform, deviceOs },
      orderBy: { releaseDate: 'desc' },
    });
    if (!row) {
      const scope = deviceOs
        ? `platform "${platform}" and OS "${deviceOs}"`
        : `platform "${platform}"`;
      throw Errors.resourceNotFound(
        'App version',
        `No app version found for ${scope}`,
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
    const existing = await this.findById(id);
    const platform = dto.platform ?? (existing.platform as AppPlatform);

    // Re-derive the OS only when the patch touches `platform` or `deviceOs`;
    // otherwise leave the stored value alone (`undefined` → Prisma skips the
    // column). Re-deriving unconditionally would blank a mobile row's train on
    // any unrelated PATCH that happened to omit `deviceOs`.
    const isReleaseTrainAffected =
      dto.platform !== undefined || dto.deviceOs !== undefined;
    const deviceOs = isReleaseTrainAffected
      ? this.resolveDeviceOs(platform, dto.deviceOs)
      : undefined;

    const effectiveVersion = dto.version ?? existing.version;
    const effectiveDeviceOs = isReleaseTrainAffected
      ? (deviceOs ?? null)
      : (existing.deviceOs as DeviceOs | null);
    await this.assertVersionAvailable(
      platform,
      effectiveDeviceOs,
      effectiveVersion,
      id,
    );

    const data: Prisma.AppVersionUpdateInput = {
      version: dto.version,
      description: dto.description,
      platform: dto.platform,
      deviceOs,
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
          deviceOs: updated.deviceOs,
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
          deviceOs: existing.deviceOs,
          version: existing.version,
        },
      });
    }
  }

  // The authoritative platform ↔ release-train rule, for BOTH create and
  // update. It cannot live in the DTO: `@IsEnum(DeviceOs)` proves only that the
  // value is some OS, and checking it against `platform` needs a sibling field
  // — which on a PATCH may not be in the body at all and has to come from the
  // stored row instead.
  private resolveDeviceOs(
    platform: AppPlatform,
    deviceOs: DeviceOs | undefined,
  ): DeviceOs | null {
    // A single-distribution platform normalizes to null rather than rejecting,
    // so a client sending a harmless extra `deviceOs` for `web` cannot desync
    // the row from the one distribution that exists.
    if (isSingleDistributionPlatform(platform)) {
      return null;
    }
    if (deviceOs === undefined) {
      throw Errors.badRequest(
        `deviceOs is required for platform "${platform}" — it ships one release per OS (${RELEASE_TRAIN_OS_BY_PLATFORM[platform].join(', ')})`,
      );
    }
    // A mismatched pairing IS rejected, because there is no safe normalization:
    // silently storing `mobile` + `windows` yields a row no client ever matches,
    // and the operator would see a successful 201 for a release nobody receives.
    if (!isReleaseTrainOsForPlatform(platform, deviceOs)) {
      throw Errors.badRequest(
        `deviceOs "${deviceOs}" is not a release train for platform "${platform}" — expected one of: ${RELEASE_TRAIN_OS_BY_PLATFORM[platform].join(', ')}`,
      );
    }
    return deviceOs;
  }

  // The DB unique index on (platform, deviceOs, version) does NOT catch
  // duplicate `web` rows, because Postgres treats their null deviceOs as
  // distinct — two `web` + `1.0.0` rows would both insert. This guard closes
  // that gap and yields a uniform 409 for every platform.
  //
  // It races under concurrent writes, but the table is administrative and
  // low-write, and the unique index is the hard backstop everywhere it applies.
  private async assertVersionAvailable(
    platform: AppPlatform,
    deviceOs: DeviceOs | null,
    version: string,
    excludeId?: string,
  ): Promise<void> {
    const clash = await this.prisma.appVersion.findFirst({
      where: {
        platform,
        deviceOs,
        version,
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (clash) {
      throw Errors.uniqueConstraintViolation('version');
    }
  }
}
