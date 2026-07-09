import 'dotenv/config';
import { expand } from 'dotenv-expand';
import * as dotenv from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import {
  PERMISSION_CATALOG,
  ROLE_DEFINITION_CATALOG,
  permissionName,
} from '../../src/common/authorization/permission-catalog';

expand(dotenv.config({ override: false }));

// Asserts the database is an exact projection of `permission-catalog.ts`,
// without booting the app. Same assertion `PermissionCatalogIntegrityService`
// makes at startup — this is the CI-friendly version.
//
//   yarn rbac:check
//
// Exits non-zero on drift, printing what is missing in each direction.
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Cannot check the catalog.');
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    const catalogPermissionNames = new Set(
      PERMISSION_CATALOG.map(permissionName),
    );
    const databasePermissionNames = new Set(
      (await prisma.permission.findMany({ select: { name: true } })).map(
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
        await prisma.role.findMany({
          where: { isSystem: true },
          select: { name: true },
        })
      ).map((row) => row.name),
    );
    const missingRoles = [...catalogRoleNames].filter(
      (name) => !seededRoleNames.has(name),
    );
    const orphanedRoles = [...seededRoleNames].filter(
      (name) => !catalogRoleNames.has(name),
    );

    const problems = [
      ['permissions missing from the database', missingFromDatabase],
      ['permissions in the database but not the catalog', orphanedInDatabase],
      ['system roles missing from the database', missingRoles],
      ['system roles in the database but not the catalog', orphanedRoles],
    ] as const;

    let hasDrift = false;
    for (const [label, offenders] of problems) {
      if (offenders.length > 0) {
        hasDrift = true;
        console.error(`[rbac:check] ${offenders.length} ${label}:`);
        for (const offender of offenders) console.error(`  - ${offender}`);
      }
    }

    if (hasDrift) {
      console.error('\n[rbac:check] FAILED — run `yarn rbac:sync` to reconcile.');
      process.exitCode = 1;
      return;
    }

    console.log(
      `[rbac:check] OK — ${catalogPermissionNames.size} permission(s) and ` +
        `${catalogRoleNames.size} system role(s) match the catalog.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(
    '[rbac:check] failed:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
