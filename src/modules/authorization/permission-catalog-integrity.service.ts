import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PERMISSION_CATALOG,
  ROLE_DEFINITION_CATALOG,
  permissionName,
} from '../../common/authorization/permission-catalog';
import { PrismaService } from '../../prisma/prisma.service';

// Refuses to boot when the database is not an exact projection of
// `permission-catalog.ts`.
//
// Why fail closed rather than warn: a permission missing from the database
// silently denies everyone who should have it, and a permission present in the
// database but absent from the catalog can never be checked by any guard —
// both are latent authorization bugs that would otherwise surface as a
// mysterious 403 in production, weeks later.
//
// `yarn rbac:check` runs the same assertion without booting the app.
@Injectable()
export class PermissionCatalogIntegrityService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PermissionCatalogIntegrityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // The e2e harness truncates every table between specs and seeds what each
    // spec needs, so the catalog is legitimately absent at boot in test.
    if (this.configService.getOrThrow<string>('nodeEnv') === 'test') return;

    await this.assertCatalogMatchesDatabase();
  }

  async assertCatalogMatchesDatabase(): Promise<void> {
    const catalogPermissionNames = new Set(
      PERMISSION_CATALOG.map(permissionName),
    );
    const databasePermissionNames = new Set(
      (await this.prisma.permission.findMany({ select: { name: true } })).map(
        (row) => row.name,
      ),
    );

    const missingFromDatabase = [...catalogPermissionNames].filter(
      (name) => !databasePermissionNames.has(name),
    );
    const orphanedInDatabase = [...databasePermissionNames].filter(
      (name) => !catalogPermissionNames.has(name),
    );

    const catalogRoleNames = new Set(Object.keys(ROLE_DEFINITION_CATALOG));
    const seededRoleNames = new Set(
      (
        await this.prisma.role.findMany({
          where: { isSystem: true },
          select: { name: true },
        })
      ).map((row) => row.name),
    );
    const missingRoles = [...catalogRoleNames].filter(
      (name) => !seededRoleNames.has(name),
    );

    const failures: string[] = [];
    if (missingFromDatabase.length > 0) {
      failures.push(
        `${missingFromDatabase.length} permission(s) defined in the catalog but missing from the database: ${missingFromDatabase.join(', ')}`,
      );
    }
    if (orphanedInDatabase.length > 0) {
      failures.push(
        `${orphanedInDatabase.length} permission(s) in the database but not in the catalog: ${orphanedInDatabase.join(', ')}`,
      );
    }
    if (missingRoles.length > 0) {
      failures.push(
        `${missingRoles.length} system role(s) missing from the database: ${missingRoles.join(', ')}`,
      );
    }

    if (failures.length > 0) {
      throw new Error(
        `Authorization catalog does not match the database.\n  - ${failures.join('\n  - ')}\n` +
          'Run `yarn rbac:sync` to project the catalog onto the database. ' +
          '(Your deploy should already do this — the `migrate` service runs it after ' +
          '`prisma migrate deploy`.) The application will not start with a drifted catalog.',
      );
    }

    this.logger.log(
      `Authorization catalog verified: ${catalogPermissionNames.size} permission(s), ${catalogRoleNames.size} system role(s)`,
    );
  }
}
