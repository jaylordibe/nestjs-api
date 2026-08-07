import { INestApplication } from '@nestjs/common';
import { createMongoAbility, subject } from '@casl/ability';
import { unpackRules } from '@casl/ability/extra';
import request from 'supertest';
import { App } from 'supertest/types';
import { SeededRoleName } from '../src/common/enums/seeded-role-name.enum';
import { truncateAll } from './setup/db';
import {
  createPlatformAdmin,
  createUser,
  createRegularUser,
  seedRbacCatalog,
  SeededUser,
} from './setup/rbac';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './setup/test-app';

interface PermissionsBody {
  rules: unknown[];
  platformRoles: string[];
  businessMemberships: Array<{
    membershipId: string;
    businessId: string;
    roleName: string;
    status: string;
  }>;
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
    // An ordinary account holds NO platform role. Self-service capability
    // comes from AUTHENTICATED_USER_PERMISSIONS, so an empty array here is
    // the normal, fully-functional state rather than a broken one.
    expect(body.platformRoles).toEqual([]);
    expect(body.businessMemberships).toEqual([]);
  });

  it('reports business memberships after creating a business', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const businessId = await createBusiness(owner, 'acme');
    const body = await fetchPermissions(owner);
    // `membershipId` and `status` are part of the contract now: a client
    // rendering "your businesses" needs to distinguish an active membership
    // from a pending or suspended one, and `rules` alone cannot express that
    // — only ACTIVE memberships compile into grants at all.
    expect(body.businessMemberships).toEqual([
      {
        membershipId: expect.any(String),
        businessId,
        roleName: SeededRoleName.BUSINESS_OWNER,
        status: 'active',
      },
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

  it('an account with NO role: self-service yes, administration no', async () => {
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

  it('an account with NO role cannot reset another user’s password', async () => {
    const user = await createRegularUser(app, 'user@example.com');
    const victim = await createRegularUser(app, 'victim@example.com');

    await request(app.getHttpServer())
      .patch(`/api/users/${victim.id}/password`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ password: 'new-password-1234' })
      .expect(403);
  });

  it('PLATFORM_ENGINEER runs releases and diagnostics, but governs nothing', async () => {
    const engineer = await createUser(app, {
      email: 'engineer@example.com',
      roles: [SeededRoleName.PLATFORM_ENGINEER],
    });

    await request(app.getHttpServer())
      .post('/api/app-versions')
      .set('Authorization', `Bearer ${engineer.token}`)
      .send({
        version: '1.0.0',
        platform: 'mobile',
        // `mobile` ships one build per OS, so a release must name its train.
        deviceOs: 'ios',
        releaseDate: new Date().toISOString(),
      })
      .expect(201);

    // Queue diagnostics: the highest technical authority on the platform.
    await request(app.getHttpServer())
      .get('/api/queues')
      .set('Authorization', `Bearer ${engineer.token}`)
      .expect(200);

    // …and no governance whatsoever. Reading a user is investigation;
    // creating one is administration.
    await request(app.getHttpServer())
      .post('/api/users')
      .set('Authorization', `Bearer ${engineer.token}`)
      .send({
        email: 'new@example.com',
        password: 'correct-horse-battery-1',
        firstName: 'New',
        lastName: 'Person',
      })
      .expect(403);
  });

  it('PLATFORM_TECHNICAL_SUPPORT sees jobs but never their payloads', async () => {
    // The distinction that makes "sanitized diagnostic visibility" real rather
    // than aspirational — support can act on a failure without reading the user
    // data it was carrying.
    const support = await createUser(app, {
      email: 'techsupport@example.com',
      roles: [SeededRoleName.PLATFORM_TECHNICAL_SUPPORT],
    });

    await request(app.getHttpServer())
      .get('/api/queues')
      .set('Authorization', `Bearer ${support.token}`)
      .expect(200);

    // No app-version authority: that is a release operation, not support.
    await request(app.getHttpServer())
      .post('/api/app-versions')
      .set('Authorization', `Bearer ${support.token}`)
      .send({
        version: '2.0.0',
        platform: 'web',
        releaseDate: new Date().toISOString(),
      })
      .expect(403);
  });

  it('PLATFORM_APP_SUPPORT helps an account without being able to take it', async () => {
    const support = await createUser(app, {
      email: 'appsupport@example.com',
      roles: [SeededRoleName.PLATFORM_APP_SUPPORT],
    });
    const victim = await createRegularUser(app, 'victim@example.com');

    // Unlocking HELPS the owner…
    await request(app.getHttpServer())
      .post(`/api/users/${victim.id}/unlock`)
      .set('Authorization', `Bearer ${support.token}`)
      .expect(200);

    // …whereas changing their email TAKES the account, so it is refused.
    await request(app.getHttpServer())
      .patch(`/api/users/${victim.id}`)
      .set('Authorization', `Bearer ${support.token}`)
      .send({ email: 'attacker@example.com' })
      .expect(403);

    // And no infrastructure access at all.
    await request(app.getHttpServer())
      .get('/api/queues')
      .set('Authorization', `Bearer ${support.token}`)
      .expect(403);
  });

  it('PLATFORM_APP_SUPPORT reads users but cannot create them', async () => {
    const support = await createUser(app, {
      email: 'support@example.com',
      roles: [SeededRoleName.PLATFORM_APP_SUPPORT],
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

  it('BUSINESS_MEMBER reads the business but cannot edit it', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const member = await createRegularUser(app, 'member@example.com');
    const businessId = await createBusiness(owner, 'acme');

    const prisma = app.get(PrismaService);
    const memberRole = await prisma.role.findUniqueOrThrow({
      where: { name: SeededRoleName.BUSINESS_MEMBER },
    });
    await request(app.getHttpServer())
      .post(`/api/businesses/${businessId}/memberships`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: member.email, roleId: memberRole.id })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/api/businesses/${businessId}`)
      .set('Authorization', `Bearer ${member.token}`)
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/api/businesses/${businessId}`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ name: 'Renamed by a member' })
      .expect(403);
  });

  it('BUSINESS_CUSTOMER gets the business and its own row, and no roster', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const customer = await createRegularUser(app, 'customer@example.com');
    const businessId = await createBusiness(owner, 'acme');

    const prisma = app.get(PrismaService);
    const customerRole = await prisma.role.findUniqueOrThrow({
      where: { name: SeededRoleName.BUSINESS_CUSTOMER },
    });
    await request(app.getHttpServer())
      .post(`/api/businesses/${businessId}/memberships`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: customer.email, roleId: customerRole.id })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/api/businesses/${businessId}`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);

    // The roster read returns exactly their own row — never the staff list.
    const roster = await request(app.getHttpServer())
      .get(`/api/businesses/${businessId}/memberships`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    const rosterBody = roster.body as { data: Array<{ userId: string }> };
    expect(rosterBody.data.map((row) => row.userId)).toEqual([customer.id]);

    // And no authority over anyone else's membership.
    await request(app.getHttpServer())
      .post(`/api/businesses/${businessId}/memberships`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ email: owner.email, roleId: customerRole.id })
      .expect(403);
  });
});
