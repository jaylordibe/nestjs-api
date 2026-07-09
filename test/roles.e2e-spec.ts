import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { RoleScope } from '../src/common/enums/role-scope.enum';
import { SeededRoleName } from '../src/common/enums/seeded-role-name.enum';
import { PrismaService } from '../src/prisma/prisma.service';
import { truncateAll } from './setup/db';
import {
  createPlatformAdmin,
  createRegularUser,
  seedRbacCatalog,
  SeededUser,
} from './setup/rbac';
import { createTestApp } from './setup/test-app';

interface ErrorBody {
  errorCode: string;
}
interface PageBody<T> {
  data: T[];
  meta: { total: number };
}
interface RoleBody {
  id: string;
  name: string;
  isSystem: boolean;
  rank: number;
  permissions: Array<{ name: string }>;
}

describe('Roles (e2e)', () => {
  let app: INestApplication<App>;
  let admin: SeededUser;
  let user: SeededUser;

  const roleFor = async (name: SeededRoleName) => {
    const prisma = app.get(PrismaService);
    return prisma.role.findUniqueOrThrow({ where: { name } });
  };

  const permissionIdsFor = async (scope: RoleScope, take = 2) => {
    const prisma = app.get(PrismaService);
    const permissions = await prisma.permission.findMany({
      where: { scope },
      take,
    });
    return permissions.map((permission) => permission.id);
  };

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll(app);
    await seedRbacCatalog(app);
    admin = await createPlatformAdmin(app);
    user = await createRegularUser(app, 'user@example.com');
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/roles is readable by any authenticated user (needed to pick a roleId)', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/roles?perPage=100')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    const body = response.body as PageBody<RoleBody>;
    expect(body.meta.total).toBe(8);
    expect(body.data.every((role) => role.isSystem)).toBe(true);
  });

  it('GET /api/permissions is readable and reflects the catalog', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/permissions?perPage=100')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    const body = response.body as PageBody<{ name: string }>;
    expect(
      body.data.some((permission) => permission.name === 'platform.all.manage'),
    ).toBe(true);
    expect(
      body.data.some(
        (permission) => permission.name === 'platform.user.read.own',
      ),
    ).toBe(true);
  });

  it('a non-admin cannot create a role', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/roles')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        name: 'sneaky',
        scope: RoleScope.PLATFORM,
        rank: 99,
        permissionIds: [],
      })
      .expect(403);
    expect((response.body as ErrorBody).errorCode).toBe('PERMISSION_DENIED');
  });

  it('a system role cannot be edited', async () => {
    const platformAdminRole = await roleFor(SeededRoleName.PLATFORM_ADMIN);
    const response = await request(app.getHttpServer())
      .patch(`/api/roles/${platformAdminRole.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ description: 'hijacked' })
      .expect(409);
    expect((response.body as ErrorBody).errorCode).toBe('RESOURCE_CONFLICT');
  });

  it('a system role cannot be deleted', async () => {
    const staffRole = await roleFor(SeededRoleName.BUSINESS_STAFF);
    await request(app.getHttpServer())
      .delete(`/api/roles/${staffRole.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(409);
  });

  it('an admin creates a custom role, and it is not a system role', async () => {
    const permissionIds = await permissionIdsFor(RoleScope.BUSINESS, 1);
    const response = await request(app.getHttpServer())
      .post('/api/roles')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        name: 'business_auditor',
        scope: RoleScope.BUSINESS,
        rank: 20,
        description: 'Read-only auditor',
        permissionIds,
      })
      .expect(201);
    const body = response.body as RoleBody;
    expect(body.isSystem).toBe(false);
    expect(body.permissions).toHaveLength(1);
  });

  it('a role cannot hold permissions from another scope', async () => {
    const platformPermissionIds = await permissionIdsFor(RoleScope.PLATFORM, 1);
    const response = await request(app.getHttpServer())
      .post('/api/roles')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        name: 'confused_role',
        scope: RoleScope.BUSINESS,
        rank: 20,
        permissionIds: platformPermissionIds,
      })
      .expect(400);
    expect((response.body as ErrorBody).errorCode).toBe('VALIDATION_FAILED');
  });

  it('a custom role cannot outrank the built-ins (rank <= 99)', async () => {
    await request(app.getHttpServer())
      .post('/api/roles')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        name: 'super_role',
        scope: RoleScope.PLATFORM,
        rank: 100,
        permissionIds: [],
      })
      .expect(400);
  });

  // ── platform role assignment ────────────────────────────────────────────

  it('an admin grants and revokes a platform role, and the ability follows', async () => {
    const supportRole = await roleFor(SeededRoleName.PLATFORM_SUPPORT);

    // Before: a regular user cannot list users.
    await request(app.getHttpServer())
      .get('/api/users')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(403);

    await request(app.getHttpServer())
      .post(`/api/users/${user.id}/roles`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ roleId: supportRole.id })
      .expect(204);

    // After: PLATFORM_SUPPORT holds `read User (any)`. The grants cache was
    // invalidated, so this takes effect on the very next request.
    await request(app.getHttpServer())
      .get('/api/users')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/api/users/${user.id}/roles/${supportRole.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(204);

    await request(app.getHttpServer())
      .get('/api/users')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(403);
  });

  it('PLATFORM_USER cannot be revoked — it carries self-service grants', async () => {
    const platformUserRole = await roleFor(SeededRoleName.PLATFORM_USER);
    const response = await request(app.getHttpServer())
      .delete(`/api/users/${user.id}/roles/${platformUserRole.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(409);
    expect((response.body as ErrorBody).errorCode).toBe('RESOURCE_CONFLICT');
  });

  it('a BUSINESS role cannot be assigned as a platform role', async () => {
    const ownerRole = await roleFor(SeededRoleName.BUSINESS_OWNER);
    const response = await request(app.getHttpServer())
      .post(`/api/users/${user.id}/roles`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ roleId: ownerRole.id })
      .expect(400);
    expect((response.body as ErrorBody).errorCode).toBe('VALIDATION_FAILED');
  });

  it('a non-admin cannot assign platform roles', async () => {
    const supportRole = await roleFor(SeededRoleName.PLATFORM_SUPPORT);
    await request(app.getHttpServer())
      .post(`/api/users/${user.id}/roles`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ roleId: supportRole.id })
      .expect(403);
  });

  it('PLATFORM_SUPPORT is read-only: it cannot edit a user', async () => {
    const supportRole = await roleFor(SeededRoleName.PLATFORM_SUPPORT);
    await request(app.getHttpServer())
      .post(`/api/users/${user.id}/roles`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ roleId: supportRole.id })
      .expect(204);

    const victim = await createRegularUser(app, 'victim@example.com');
    await request(app.getHttpServer())
      .patch(`/api/users/${victim.id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ firstName: 'Owned' })
      .expect(403);
  });
});
