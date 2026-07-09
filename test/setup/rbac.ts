import { INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  assignPlatformRole,
  seedPermissions,
  seedRoles,
} from '../../prisma/rbac-seeder';
import { SeededRoleName } from '../../src/common/enums/seeded-role-name.enum';
import { PrismaService } from '../../src/prisma/prisma.service';

// Shared RBAC fixtures.
//
// `truncateAll` wipes `roles` / `permissions` between specs, and nothing works
// without them: even `POST /auth/register` needs PLATFORM_USER to exist,
// because a user's own self-service grants come from that role. So every spec
// calls `seedRbacCatalog(app)` in `beforeEach`, right after truncating.
//
// The catalog is projected from `permission-catalog.ts` by the same seeder
// production uses, so tests exercise the real grant graph rather than a
// hand-maintained fixture that could drift from it.

export const TEST_PASSWORD = 'correct-horse-battery-1';

export async function seedRbacCatalog(
  app: INestApplication<App>,
): Promise<void> {
  const prisma = app.get(PrismaService);
  await seedPermissions(prisma);
  await seedRoles(prisma);
}

export async function loginAs(
  app: INestApplication<App>,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/api/auth/login')
    .send({ identifier: email, password });
  const body = response.body as { accessToken?: string };
  if (!body.accessToken) {
    throw new Error(
      `loginAs(${email}) failed: ${response.status} ${JSON.stringify(response.body)}`,
    );
  }
  return body.accessToken;
}

export interface SeededUser {
  id: string;
  email: string;
  token: string;
}

/**
 * Creates a verified user holding PLATFORM_USER plus any extra platform roles,
 * then logs in and returns a usable token.
 *
 * Rows are inserted directly rather than through `POST /auth/register` so the
 * spec controls `emailVerifiedAt` and the role set. PLATFORM_USER is always
 * granted, mirroring `UsersService.create`.
 */
export async function createPlatformUser(
  app: INestApplication<App>,
  options: {
    email: string;
    roles?: readonly SeededRoleName[];
    firstName?: string;
    lastName?: string;
  },
): Promise<SeededUser> {
  const prisma = app.get(PrismaService);
  const email = options.email.toLowerCase();

  const user = await prisma.user.create({
    data: {
      email,
      password: await bcrypt.hash(TEST_PASSWORD, 10),
      firstName: options.firstName ?? 'Test',
      lastName: options.lastName ?? 'User',
      // Seeded straight into the DB, bypassing the register flow, so the
      // email-verification login gate has to be satisfied explicitly.
      emailVerifiedAt: new Date(),
    },
  });

  const roles = new Set<SeededRoleName>([
    SeededRoleName.PLATFORM_USER,
    ...(options.roles ?? []),
  ]);
  for (const roleName of roles) {
    await assignPlatformRole(prisma, user.id, roleName);
  }

  return { id: user.id, email, token: await loginAs(app, email) };
}

// A platform administrator: holds `manage all`.
export function createPlatformAdmin(
  app: INestApplication<App>,
  email = 'admin@example.com',
): Promise<SeededUser> {
  return createPlatformUser(app, {
    email,
    roles: [SeededRoleName.PLATFORM_ADMIN],
    firstName: 'Admin',
  });
}

// An ordinary registered user: PLATFORM_USER only (self-service grants).
export function createRegularUser(
  app: INestApplication<App>,
  email = 'user@example.com',
): Promise<SeededUser> {
  return createPlatformUser(app, { email, firstName: 'Regular' });
}

/**
 * Registers through the real `POST /auth/register` endpoint, then marks the
 * email verified and logs in. Use where the spec is exercising the register
 * flow itself; `createRegularUser` is cheaper otherwise.
 */
export async function registerAndLogin(
  app: INestApplication<App>,
  email = 'user@example.com',
): Promise<SeededUser> {
  await request(app.getHttpServer()).post('/api/auth/register').send({
    email,
    password: TEST_PASSWORD,
    firstName: 'Regular',
    lastName: 'User',
  });

  const prisma = app.get(PrismaService);
  // `findFirst`, not `findUniqueOrThrow`: `email` is unique only among live
  // rows (a partial index), so Prisma does not expose it as a unique selector.
  const user = await prisma.user.findFirst({ where: { email } });
  if (!user)
    throw new Error(`registerAndLogin(${email}): user was not created`);

  await prisma.user.update({
    where: { id: user.id },
    data: { emailVerifiedAt: new Date() },
  });

  return { id: user.id, email, token: await loginAs(app, email) };
}
