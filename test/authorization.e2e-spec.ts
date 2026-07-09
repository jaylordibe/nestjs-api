import { INestApplication } from '@nestjs/common';
import { createMongoAbility, subject } from '@casl/ability';
import { unpackRules } from '@casl/ability/extra';
import request from 'supertest';
import { App } from 'supertest/types';
import { SeededRoleName } from '../src/common/enums/seeded-role-name.enum';
import { truncateAll } from './setup/db';
import {
  createPlatformAdmin,
  createPlatformUser,
  createRegularUser,
  seedRbacCatalog,
  SeededUser,
} from './setup/rbac';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './setup/test-app';

interface PermissionsBody {
  rules: unknown[];
  platformRoles: string[];
  businessMemberships: Array<{ businessId: string; roleName: string }>;
}

describe('Authorization (e2e)', () => {
  let app: INestApplication<App>;

  const fetchPermissions = async (
    actor: SeededUser,
  ): Promise<PermissionsBody> => {
    const response = await request(app.getHttpServer())
      .get('/api/users/me/permissions')
      .set('Authorization', `Bearer ${actor.token}`)
      .expect(200);
    return response.body as PermissionsBody;
  };

  const createBusiness = async (owner: SeededUser, slug: string) => {
    const response = await request(app.getHttpServer())
      .post('/api/businesses')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: slug, slug })
      .expect(201);
    return (response.body as { id: string }).id;
  };

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll(app);
    await seedRbacCatalog(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('an unauthenticated request is rejected (JwtAuthGuard is global)', async () => {
    await request(app.getHttpServer()).get('/api/businesses').expect(401);
  });

  it('@Public() routes remain reachable anonymously', async () => {
    await request(app.getHttpServer()).get('/api/health/liveness').expect(200);
    await request(app.getHttpServer())
      .get('/api/enums/role-scopes')
      .expect(200);
    await request(app.getHttpServer()).get('/api/public/ping').expect(200);
  });

  // ── client-side ability sync ────────────────────────────────────────────

  it('GET /users/me/permissions reports the caller’s roles', async () => {
    const user = await createRegularUser(app, 'user@example.com');
    const body = await fetchPermissions(user);
    expect(body.platformRoles).toEqual([SeededRoleName.PLATFORM_USER]);
    expect(body.businessMemberships).toEqual([]);
  });

  it('reports business memberships after creating a business', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const businessId = await createBusiness(owner, 'acme');
    const body = await fetchPermissions(owner);
    expect(body.businessMemberships).toEqual([
      { businessId, roleName: SeededRoleName.BUSINESS_OWNER },
    ]);
  });

  /**
   * The whole point of the design: the client rebuilds the ability from the
   * packed rules and reaches the SAME verdict the server does. If these ever
   * diverge, every frontend permission check is a lie.
   */
  it('rebuilt client ability agrees with the server, decision for decision', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const stranger = await createRegularUser(app, 'stranger@example.com');
    const ownBusinessId = await createBusiness(owner, 'own-co');
    const otherBusinessId = await createBusiness(stranger, 'other-co');

    const body = await fetchPermissions(owner);
    const clientAbility = createMongoAbility(
      unpackRules(body.rules as never) as never,
    );

    // Client says: I may update my own business.
    expect(
      clientAbility.can('update', subject('Business', { id: ownBusinessId })),
    ).toBe(true);
    // Server agrees.
    await request(app.getHttpServer())
      .patch(`/api/businesses/${ownBusinessId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Renamed' })
      .expect(200);

    // Client says: I may NOT touch the other business.
    expect(
      clientAbility.can('update', subject('Business', { id: otherBusinessId })),
    ).toBe(false);
    // Server agrees — and answers 404, never 403.
    await request(app.getHttpServer())
      .patch(`/api/businesses/${otherBusinessId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Hijacked' })
      .expect(404);

    // Client says: I may read my own profile but not a stranger's.
    expect(clientAbility.can('read', subject('User', { id: owner.id }))).toBe(
      true,
    );
    expect(
      clientAbility.can('read', subject('User', { id: stranger.id })),
    ).toBe(false);
  });

  it('a platform admin’s rebuilt ability is unrestricted', async () => {
    const admin = await createPlatformAdmin(app);
    const body = await fetchPermissions(admin);
    const clientAbility = createMongoAbility(
      unpackRules(body.rules as never) as never,
    );

    expect(clientAbility.can('manage', 'all')).toBe(true);
    expect(
      clientAbility.can('delete', subject('Business', { id: 'anything' })),
    ).toBe(true);
  });

  // ── the seeded roles, against representative endpoints ──────────────────

  it('PLATFORM_USER: self-service yes, administration no', async () => {
    const user = await createRegularUser(app, 'user@example.com');

    await request(app.getHttpServer())
      .get('/api/users/me')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);

    // `update User (own)` must NOT unlock the administrative route.
    await request(app.getHttpServer())
      .get('/api/users')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(403);
    await request(app.getHttpServer())
      .patch(`/api/users/${user.id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ firstName: 'Escalated' })
      .expect(403);
  });

  it('PLATFORM_USER cannot reset another user’s password via the admin route', async () => {
    const user = await createRegularUser(app, 'user@example.com');
    const victim = await createRegularUser(app, 'victim@example.com');

    await request(app.getHttpServer())
      .patch(`/api/users/${victim.id}/password`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ password: 'new-password-1234' })
      .expect(403);
  });

  it('PLATFORM_DEVELOPER manages app versions but not users', async () => {
    const developer = await createPlatformUser(app, {
      email: 'dev@example.com',
      roles: [SeededRoleName.PLATFORM_DEVELOPER],
    });

    await request(app.getHttpServer())
      .post('/api/app-versions')
      .set('Authorization', `Bearer ${developer.token}`)
      .send({
        version: '1.0.0',
        platform: 'mobile',
        releaseDate: new Date().toISOString(),
      })
      .expect(201);

    await request(app.getHttpServer())
      .get('/api/users')
      .set('Authorization', `Bearer ${developer.token}`)
      .expect(403);
  });

  it('PLATFORM_SUPPORT reads users but cannot create or edit them', async () => {
    const support = await createPlatformUser(app, {
      email: 'support@example.com',
      roles: [SeededRoleName.PLATFORM_SUPPORT],
    });

    await request(app.getHttpServer())
      .get('/api/users')
      .set('Authorization', `Bearer ${support.token}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/users')
      .set('Authorization', `Bearer ${support.token}`)
      .send({
        email: 'new@example.com',
        password: 'correct-horse-battery-1',
        firstName: 'New',
        lastName: 'Person',
      })
      .expect(403);
  });

  it('BUSINESS_STAFF reads the business but cannot edit it', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const staff = await createRegularUser(app, 'staff@example.com');
    const businessId = await createBusiness(owner, 'acme');

    const prisma = app.get(PrismaService);
    const staffRole = await prisma.role.findUniqueOrThrow({
      where: { name: SeededRoleName.BUSINESS_STAFF },
    });
    await request(app.getHttpServer())
      .post(`/api/businesses/${businessId}/members`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: staff.email, roleId: staffRole.id })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/api/businesses/${businessId}`)
      .set('Authorization', `Bearer ${staff.token}`)
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/api/businesses/${businessId}`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({ name: 'Renamed by staff' })
      .expect(403);
  });
});
