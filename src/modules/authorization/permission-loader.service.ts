import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AuthorizationAction,
  AuthorizationSubject,
} from '../../common/authorization/permission-catalog';
import type { PermissionOwnership } from '../../common/enums/permission-ownership.enum';
import type { RoleScope } from '../../common/enums/role-scope.enum';
import { RedisService } from '../../common/redis/redis.service';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  AuthorizationGrants,
  BusinessMembershipGrant,
  PermissionGrant,
} from './ability.factory';

// Bump this when the cached JSON shape changes, so old entries are ignored
// rather than deserialized into the wrong shape after a deploy.
const GRANTS_CACHE_VERSION = 'v1';
const GRANTS_KEY_PREFIX = `authz:${GRANTS_CACHE_VERSION}:grants`;

// A monotonically increasing counter embedded in every cache key. Bumping it
// invalidates every cached grant on the platform with one atomic INCR — the
// right tool when a *role definition* changes and every holder of that role
// is affected. Stale keys are never deleted; they simply age out via TTL.
export const AUTHORIZATION_EPOCH_KEY = 'authz:epoch';

// Shape of the one nested query below. Declared so the mapping code stays
// typed without leaking Prisma's generated payload types outward.
interface RolePermissionRow {
  permission: {
    action: string;
    subject: string;
    scope: string;
    ownership: string;
  };
}

@Injectable()
export class PermissionLoaderService {
  private readonly logger = new Logger(PermissionLoaderService.name);
  private readonly grantsCacheTtlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    configService: ConfigService,
  ) {
    this.grantsCacheTtlSeconds = configService.getOrThrow<number>(
      'authorization.grantsCacheTtlSeconds',
    );
  }

  // Grants for one user: their PLATFORM roles' permissions, plus the
  // permissions of each business role they hold, tagged with the business.
  //
  // Redis is a cache, never an authority. Any failure — outage, corrupt JSON,
  // parse error — falls through to the database. There is no path here where a
  // Redis problem grants access it shouldn't; the worst case is a slow request.
  // (Contrast JwtStrategy's logout blocklist, which fails *open* by design.)
  async loadGrants(userId: string): Promise<AuthorizationGrants> {
    const epoch = await this.readEpoch();
    const cacheKey = this.buildCacheKey(epoch, userId);

    const cached = await this.readCachedGrants(cacheKey);
    if (cached) return cached;

    const grants = await this.loadGrantsFromDatabase(userId);
    await this.writeCachedGrants(cacheKey, grants);
    return grants;
  }

  // Called whenever a user's own role set changes: a platform role assigned or
  // revoked, or a business membership added, changed, or removed. Deletes the
  // one exact key — no SCAN, no wildcard.
  async invalidateUser(userId: string): Promise<void> {
    try {
      const epoch = await this.readEpoch();
      await this.redis.client.del(this.buildCacheKey(epoch, userId));
    } catch (error) {
      // A failed invalidation means the user keeps stale grants until the TTL
      // expires. Log loudly: this is the one place the backstop matters.
      this.logger.error(
        `Failed to invalidate authorization cache for user ${userId}; ` +
          `stale grants persist for up to ${this.grantsCacheTtlSeconds}s: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  // Called when a ROLE's definition changes (its permission set was edited),
  // which affects every holder of that role. One atomic INCR retires every
  // cached grant on the platform.
  async invalidateAllUsers(): Promise<void> {
    try {
      await this.redis.client.incr(AUTHORIZATION_EPOCH_KEY);
    } catch (error) {
      this.logger.error(
        'Failed to bump the authorization epoch; stale grants persist for up to ' +
          `${this.grantsCacheTtlSeconds}s: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private buildCacheKey(epoch: string, userId: string): string {
    return `${GRANTS_KEY_PREFIX}:${epoch}:${userId}`;
  }

  private async readEpoch(): Promise<string> {
    try {
      return (await this.redis.client.get(AUTHORIZATION_EPOCH_KEY)) ?? '0';
    } catch {
      // Redis down: use a stable epoch so the key we then fail to read is at
      // least consistent. Everything falls through to the database anyway.
      return '0';
    }
  }

  private async readCachedGrants(
    cacheKey: string,
  ): Promise<AuthorizationGrants | null> {
    try {
      const raw = await this.redis.client.get(cacheKey);
      return raw ? (JSON.parse(raw) as AuthorizationGrants) : null;
    } catch (error) {
      this.logger.warn(
        `Authorization grants cache read failed (falling back to the database): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private async writeCachedGrants(
    cacheKey: string,
    grants: AuthorizationGrants,
  ): Promise<void> {
    try {
      await this.redis.client.set(
        cacheKey,
        JSON.stringify(grants),
        'EX',
        this.grantsCacheTtlSeconds,
      );
    } catch (error) {
      this.logger.warn(
        `Authorization grants cache write failed (request still served): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // One round trip. Prisma resolves both nested collections in a single
  // engine call, so this is not an N+1 despite the four levels of nesting.
  private async loadGrantsFromDatabase(
    userId: string,
  ): Promise<AuthorizationGrants> {
    const userWithRoles = await this.prisma.scoped.user.findUnique({
      where: { id: userId },
      select: {
        userRoles: {
          select: {
            role: { select: { permissions: { select: PERMISSION_SELECT } } },
          },
        },
        businessMembers: {
          select: {
            businessId: true,
            role: { select: { permissions: { select: PERMISSION_SELECT } } },
          },
        },
      },
    });

    if (!userWithRoles) {
      // Soft-deleted or absent. JwtStrategy already rejects these, so this is
      // defence in depth: an empty grant set authorizes nothing.
      return { platformPermissions: [], businessMemberships: [] };
    }

    const platformPermissions = userWithRoles.userRoles.flatMap((userRole) =>
      userRole.role.permissions.map(toPermissionGrant),
    );

    const businessMemberships: BusinessMembershipGrant[] =
      userWithRoles.businessMembers.map((membership) => ({
        businessId: membership.businessId,
        permissions: membership.role.permissions.map(toPermissionGrant),
      }));

    return { platformPermissions, businessMemberships };
  }
}

const PERMISSION_SELECT = {
  permission: {
    select: { action: true, subject: true, scope: true, ownership: true },
  },
} as const;

// The DB columns are plain `String` (this codebase declares no Postgres enums),
// so the enum types are asserted here, at the single database→application
// boundary the grants pass through.
function toPermissionGrant(row: RolePermissionRow): PermissionGrant {
  return {
    action: row.permission.action as AuthorizationAction,
    subject: row.permission.subject as AuthorizationSubject,
    scope: row.permission.scope as RoleScope,
    ownership: row.permission.ownership as PermissionOwnership,
  };
}
