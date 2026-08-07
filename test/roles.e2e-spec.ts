import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { RoleScope } from '../src/common/enums/role-scope.enum';
import { SeededRoleName } from '../src/common/enums/seeded-role-name.enum';
import { PrismaService } from '../src/prisma/prisma.service';
import { truncateAll } from './setup/db';
import {
  addMembership,
  createBusinessWithOwner,
  createPlatformAdmin,
  createRegularUser,
  createUser,
  roleIdFor,
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
  scope: RoleScope;
  rank: number;
  permissions: Array<{ name: string }>;
}

describe('Roles (e2e)', () => {
  let app: INestApplication<App>;
  let admin: SeededUser;
  let user: SeededUser;

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

  describe('the catalog is readable', () => {
    it('lists every seeded role to any authenticated caller', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/roles?perPage=100')
        .set('Authorization', `Bearer ${user.token}`)
        .expect(200);

      const body = response.body as PageBody<RoleBody>;
      // Derived, never a literal: the assertion and the catalog then move
      // together, so adding a role cannot fail this test for the wrong reason.
      expect(body.meta.total).toBe(Object.values(SeededRoleName).length);
    });

    it('is readable with NO platform role at all', async () => {
      // `read Role` is intrinsic, not granted by any role — a user needs a
      // roleId before they can invite anyone, and this fixture holds nothing.
      const prisma = app.get(PrismaService);
      const roleCount = await prisma.userRole.count({
        where: { userId: user.id },
      });
      expect(roleCount).toBe(0);

      await request(app.getHttpServer())
        .get('/api/roles')
        .set('Authorization', `Bearer ${user.token}`)
        .expect(200);
    });

    it('GET /api/permissions reflects the catalog', async () => {
      const response = await request(app.getHttpServer())
        // 100 is `MetaQueryDto`'s hard ceiling — asking for more is a 400, not
        // a bigger page. Deliberately not raised for this endpoint: an
        // unbounded page size is the same OOM risk as an unpaginated list.
        .get('/api/permissions?perPage=100')
        .set('Authorization', `Bearer ${user.token}`)
        .expect(200);

      const body = response.body as PageBody<{ name: string }>;
      expect(body.meta.total).toBeGreaterThan(0);
      expect(body.data.some((row) => row.name === 'platform.all.manage')).toBe(
        true,
      );
    });

    it('filters by scope', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/roles?scope=${RoleScope.BUSINESS}&perPage=100`)
        .set('Authorization', `Bearer ${user.token}`)
        .expect(200);

      const body = response.body as PageBody<RoleBody>;
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data.every((role) => role.scope === RoleScope.BUSINESS)).toBe(
        true,
      );
    });
  });

  describe('roles are code-owned — no runtime mutation exists', () => {
    // These are the whole point of the read-only controller. A 404 here means
    // the route is genuinely absent, not merely guarded: a guarded route would
    // answer 403, and a 403 is a door with a lock rather than no door.
    it.each([
      ['post', '/api/roles'],
      ['patch', '/api/roles/00000000-0000-4000-8000-000000000001'],
      ['delete', '/api/roles/00000000-0000-4000-8000-000000000001'],
    ])(
      '%s %s does not exist, even for a platform admin',
      async (method, path) => {
        await request(app.getHttpServer())
          [method as 'post' | 'patch' | 'delete'](path)
          .set('Authorization', `Bearer ${admin.token}`)
          .send({ name: 'smuggled_role', scope: 'platform', rank: 50 })
          .expect(404);
      },
    );

    it('leaves no create/update/delete permission in the catalog', async () => {
      const prisma = app.get(PrismaService);
      const roleWritePermissions = await prisma.permission.findMany({
        where: {
          subject: 'Role',
          action: { in: ['create', 'update', 'delete'] },
        },
      });
      expect(roleWritePermissions).toEqual([]);
    });
  });

  describe('assignment ceiling on the role picker', () => {
    it('offers a business admin only roles at or below its own rank', async () => {
      const owner = await createRegularUser(app, 'owner@example.com');
      const business = await createBusinessWithOwner(app, owner.id);
      const businessAdmin = await createRegularUser(app, 'ba@example.com');
      await addMembership(
        app,
        business.id,
        businessAdmin.id,
        SeededRoleName.BUSINESS_ADMIN,
      );

      const response = await request(app.getHttpServer())
        .get(`/api/roles?assignableIn=${business.id}&perPage=100`)
        .set('Authorization', `Bearer ${businessAdmin.token}`)
        .expect(200);

      const body = response.body as PageBody<RoleBody>;
      const names = body.data.map((role) => role.name);
      expect(names).toContain(SeededRoleName.BUSINESS_ADMIN);
      expect(names).toContain(SeededRoleName.BUSINESS_MEMBER);
      // The one that matters: an admin must never be offered OWNER, because it
      // must never be able to mint one.
      expect(names).not.toContain(SeededRoleName.BUSINESS_OWNER);
      // …and platform roles are not assignable inside a business at all.
      expect(names).not.toContain(SeededRoleName.PLATFORM_ADMIN);
    });

    it('offers a stranger to the business nothing, without leaking a 403', async () => {
      const owner = await createRegularUser(app, 'owner2@example.com');
      const business = await createBusinessWithOwner(app, owner.id, 'other');

      const response = await request(app.getHttpServer())
        .get(`/api/roles?assignableIn=${business.id}`)
        .set('Authorization', `Bearer ${user.token}`)
        .expect(200);

      const body = response.body as PageBody<RoleBody>;
      // An empty page, not a 403 — otherwise the status code becomes an oracle
      // for which businesses the caller belongs to.
      expect(body.data).toEqual([]);
    });
  });

  describe('platform role assignment', () => {
    it('an admin grants and revokes a platform role, and the ability follows', async () => {
      const engineerRoleId = await roleIdFor(
        app,
        SeededRoleName.PLATFORM_ENGINEER,
      );

      await request(app.getHttpServer())
        .post(`/api/users/${user.id}/roles`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ roleId: engineerRoleId })
        .expect(204);

      // App versions are an engineer capability, so the grant is observable.
      await request(app.getHttpServer())
        .get('/api/queues')
        .set('Authorization', `Bearer ${user.token}`)
        .expect(200);

      await request(app.getHttpServer())
        .delete(`/api/users/${user.id}/roles/${engineerRoleId}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(204);

      await request(app.getHttpServer())
        .get('/api/queues')
        .set('Authorization', `Bearer ${user.token}`)
        .expect(403);
    });

    it('every platform role is revocable — an account with none still works', async () => {
      const supportRoleId = await roleIdFor(
        app,
        SeededRoleName.PLATFORM_APP_SUPPORT,
      );
      const support = await createUser(app, {
        email: 'support@example.com',
        roles: [SeededRoleName.PLATFORM_APP_SUPPORT],
      });

      await request(app.getHttpServer())
        .delete(`/api/users/${support.id}/roles/${supportRoleId}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(204);

      // The account is restricted, not broken: self-service still works,
      // because it never came from a role in the first place.
      await request(app.getHttpServer())
        .get('/api/users/me')
        .set('Authorization', `Bearer ${support.token}`)
        .expect(200);
    });

    it('rejects a BUSINESS role assigned platform-wide', async () => {
      const businessOwnerRoleId = await roleIdFor(
        app,
        SeededRoleName.BUSINESS_OWNER,
      );

      const response = await request(app.getHttpServer())
        .post(`/api/users/${user.id}/roles`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ roleId: businessOwnerRoleId })
        .expect(400);

      expect((response.body as ErrorBody).errorCode).toBe('VALIDATION_FAILED');
    });

    it('a non-admin cannot assign platform roles', async () => {
      const adminRoleId = await roleIdFor(app, SeededRoleName.PLATFORM_ADMIN);

      await request(app.getHttpServer())
        .post(`/api/users/${user.id}/roles`)
        .set('Authorization', `Bearer ${user.token}`)
        .send({ roleId: adminRoleId })
        .expect(403);
    });

    it('an engineer cannot promote itself into governance', async () => {
      // The separation the platform role split exists to create. An engineer
      // holds the highest TECHNICAL authority and no governance authority, so
      // it must not be able to hand itself PLATFORM_ADMIN.
      const engineer = await createUser(app, {
        email: 'engineer@example.com',
        roles: [SeededRoleName.PLATFORM_ENGINEER],
      });
      const adminRoleId = await roleIdFor(app, SeededRoleName.PLATFORM_ADMIN);

      await request(app.getHttpServer())
        .post(`/api/users/${engineer.id}/roles`)
        .set('Authorization', `Bearer ${engineer.token}`)
        .send({ roleId: adminRoleId })
        .expect(403);

      const prisma = app.get(PrismaService);
      const assignments = await prisma.userRole.count({
        where: { userId: engineer.id },
      });
      expect(assignments).toBe(1);
    });
  });
});
