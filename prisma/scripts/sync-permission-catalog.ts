import 'dotenv/config';
import { expand } from 'dotenv-expand';
import * as dotenv from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { seedPermissions, seedRoles } from '../rbac-seeder';

expand(dotenv.config({ override: false }));

/**
 * Projects `src/common/authorization/permission-catalog.ts` onto the database:
 * permissions, the system roles, and their grants. Nothing else.
 *
 *   yarn rbac:sync
 *
 * THIS MUST RUN ON EVERY DEPLOY, immediately after `prisma migrate deploy`.
 *
 * The application refuses to start when the catalog and the database disagree
 * (`PermissionCatalogIntegrityService`). So the first deploy that introduces a
 * new permission would otherwise apply its migration, fail the boot check, and
 * never pass its healthcheck.
 *
 * Deliberately separate from `yarn prisma:seed`, which ALSO creates the seeded
 * admin and demo users and therefore requires `SEED_ADMIN_*` / `SEED_USER_*`.
 * Those are bootstrap concerns: an operator who removes them from `.env` after
 * the first deploy must not thereby break every subsequent deploy. This script
 * needs only `DATABASE_URL`.
 *
 * Idempotent: inserts what is missing, updates descriptions, deletes rows the
 * catalog no longer defines.
 */
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Cannot sync the catalog.');
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    // Order matters: roles reference permissions.
    await seedPermissions(prisma);
    await seedRoles(prisma);
    console.log('[rbac:sync] catalog projected onto the database');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(
    '[rbac:sync] failed:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
