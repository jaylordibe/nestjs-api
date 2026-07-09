import 'dotenv/config';
import { expand } from 'dotenv-expand';
import * as dotenv from 'dotenv';
import * as bcrypt from 'bcrypt';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { SeededRoleName } from '../src/common/enums/seeded-role-name.enum';
import {
  assignPlatformRole,
  seedPermissions,
  seedRoles,
} from './rbac-seeder';

// Load .env (with ${VAR} expansion) before touching process.env, matching
// how the runtime app bootstraps via @nestjs/config + prisma.config.ts.
expand(dotenv.config({ override: false }));

// Same cost factor as UsersService. Keep in sync if that constant changes.
const BCRYPT_ROUNDS = 12;

// Same complexity rule enforced by DTOs at runtime. Seeded passwords go
// through this explicitly because the seed script bypasses the HTTP
// validation pipeline — we don't want a deploy to quietly install a 4-char
// admin password if someone typo'd the env var.
const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).+$/;

interface SeedUser {
  label: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  // PLATFORM-scope roles granted through `user_roles`. Every user gets
  // PLATFORM_USER (the self-service grants); staff get an additional role.
  platformRoles: readonly SeededRoleName[];
}

function readSeedUser(
  prefix: 'ADMIN' | 'USER',
  firstName: string,
  lastName: string,
  platformRoles: readonly SeededRoleName[],
): SeedUser {
  const emailKey = `SEED_${prefix}_EMAIL`;
  const passwordKey = `SEED_${prefix}_PASSWORD`;
  const email = process.env[emailKey];
  const password = process.env[passwordKey];

  if (!email || !password) {
    throw new Error(
      `${emailKey} and ${passwordKey} must be set before running the seeder. ` +
        `Set them in .env for local dev or in your deploy environment for staging/prod.`,
    );
  }

  if (
    password.length < 12 ||
    password.length > 72 ||
    !PASSWORD_PATTERN.test(password)
  ) {
    throw new Error(
      `${passwordKey} must be 12–72 characters and contain at least one ` +
        `letter and one digit — same rule the app enforces at sign-up.`,
    );
  }

  return {
    label: prefix.toLowerCase(),
    email,
    password,
    firstName,
    lastName,
    platformRoles,
  };
}

async function upsertSeedUser(
  prisma: PrismaClient,
  user: SeedUser,
): Promise<void> {
  const email = user.email.toLowerCase();
  // `findFirst`: email is unique only among live rows (partial index).
  const existing = await prisma.user.findFirst({ where: { email } });

  let userId: string;
  if (existing) {
    // Idempotent re-run: don't clobber anything. If an operator has
    // manually rotated the seeded admin's password, a repeat seed should
    // not reset it.
    console.log(`[seed] ${user.label}: already exists (${email}) — leaving as is.`);
    userId = existing.id;
  } else {
    const created = await prisma.user.create({
      data: {
        email,
        password: await bcrypt.hash(user.password, BCRYPT_ROUNDS),
        passwordChangedAt: new Date(),
        firstName: user.firstName,
        lastName: user.lastName,
        emailVerifiedAt: new Date(),
      },
    });
    console.log(`[seed] ${user.label}: created ${created.email} (${created.id})`);
    userId = created.id;
  }

  // Role links are reconciled on every run even for a pre-existing user, so a
  // seeded admin that predates RBAC picks up its `user_roles` rows.
  for (const roleName of user.platformRoles) {
    await assignPlatformRole(prisma, userId, roleName);
  }
  console.log(
    `[seed] ${user.label}: platform role(s) ${user.platformRoles.join(', ')} in sync`,
  );
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Cannot seed.');
  }

  // Every user carries PLATFORM_USER — it holds the self-service grants that
  // make /users/me/* and device-token management work. Staff roles are additive.
  const admin = readSeedUser('ADMIN', 'Admin', 'User', [
    SeededRoleName.PLATFORM_USER,
    SeededRoleName.PLATFORM_ADMIN,
  ]);
  const user = readSeedUser('USER', 'Regular', 'User', [
    SeededRoleName.PLATFORM_USER,
  ]);

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    // Order matters: roles reference permissions, users reference roles.
    await seedPermissions(prisma);
    await seedRoles(prisma);
    await upsertSeedUser(prisma, admin);
    await upsertSeedUser(prisma, user);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(
    '[seed] failed:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
