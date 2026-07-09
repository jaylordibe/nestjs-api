import type { PrismaClient } from '@prisma/client';
import {
  PERMISSION_CATALOG,
  ROLE_DEFINITION_CATALOG,
  permissionName,
} from '../src/common/authorization/permission-catalog';
import { SeededRoleName } from '../src/common/enums/seeded-role-name.enum';

// ─────────────────────────────────────────────────────────────────────────
// Projects `permission-catalog.ts` onto the database.
//
// Shared by `prisma/seed.ts` (writes) and `prisma/scripts/check-permission-
// catalog.ts` (reads, asserts). The database is a projection of the catalog,
// never the other way around: `PermissionCatalogIntegrityService` refuses to
// boot the app when the two disagree.
//
// Every step is idempotent, so `yarn prisma:seed` is safe to re-run.
// ─────────────────────────────────────────────────────────────────────────

// The e2e harness reseeds the catalog before every single test; its progress
// chatter would drown the actual test output.
const isTestEnvironment = process.env.NODE_ENV === 'test';
function log(message: string): void {
  if (!isTestEnvironment) console.log(message);
}

export async function seedPermissions(prisma: PrismaClient): Promise<void> {
  for (const definition of PERMISSION_CATALOG) {
    const name = permissionName(definition);
    await prisma.permission.upsert({
      where: { name },
      create: {
        name,
        action: definition.action,
        subject: definition.subject,
        scope: definition.scope,
        ownership: definition.ownership,
        description: definition.description,
      },
      // Descriptions are prose and may be reworded; the identity columns are
      // baked into `name` and so can never drift under an upsert.
      update: { description: definition.description },
    });
  }

  // Remove rows the catalog no longer defines. `role_permissions` cascades,
  // so a custom role loses the grant too — which is correct: the permission
  // no longer exists in code, and nothing can check it. Leaving orphans would
  // fail the boot integrity check (DB ⊆ catalog).
  const catalogNames = PERMISSION_CATALOG.map(permissionName);
  const { count: removedPermissionCount } = await prisma.permission.deleteMany({
    where: { name: { notIn: catalogNames } },
  });
  if (removedPermissionCount > 0) {
    log(
      `[seed] permissions: removed ${removedPermissionCount} row(s) no longer in the catalog`,
    );
  }
  log(`[seed] permissions: ${catalogNames.length} in sync`);
}

export async function seedRoles(prisma: PrismaClient): Promise<void> {
  for (const [roleName, definition] of Object.entries(
    ROLE_DEFINITION_CATALOG,
  )) {
    const role = await prisma.role.upsert({
      where: { name: roleName },
      create: {
        name: roleName,
        scope: definition.scope,
        rank: definition.rank,
        description: definition.description,
        isSystem: true,
      },
      update: {
        scope: definition.scope,
        rank: definition.rank,
        description: definition.description,
        isSystem: true,
      },
    });

    // Reconcile this role's grants to exactly the catalog: insert what's
    // missing, delete what's extra. A seeded role's permission set is owned by
    // code, so an operator's manual grant is intentionally reverted here.
    const desiredPermissionNames = definition.permissions.map(permissionName);
    const desiredPermissions = await prisma.permission.findMany({
      where: { name: { in: desiredPermissionNames } },
      select: { id: true, name: true },
    });
    if (desiredPermissions.length !== desiredPermissionNames.length) {
      const found = new Set(desiredPermissions.map((row) => row.name));
      const missing = desiredPermissionNames.filter((name) => !found.has(name));
      throw new Error(
        `Role "${roleName}" grants permission(s) absent from the permissions table: ${missing.join(', ')}. ` +
          `Run seedPermissions first.`,
      );
    }

    await prisma.rolePermission.deleteMany({
      where: {
        roleId: role.id,
        permission: { name: { notIn: desiredPermissionNames } },
      },
    });
    for (const permission of desiredPermissions) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId: role.id, permissionId: permission.id },
        },
        create: { roleId: role.id, permissionId: permission.id },
        update: {},
      });
    }

    log(
      `[seed] role ${roleName}: ${desiredPermissions.length} permission(s) in sync`,
    );
  }
}

// Idempotently grant a PLATFORM role to a user. Business roles are never
// assigned here — they belong to a `business_members` row, and the database
// rejects a business role in `user_roles` outright.
export async function assignPlatformRole(
  prisma: PrismaClient,
  userId: string,
  roleName: SeededRoleName,
): Promise<void> {
  const role = await prisma.role.findUniqueOrThrow({
    where: { name: roleName },
  });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId, roleId: role.id } },
    create: { userId, roleId: role.id },
    update: {},
  });
}
