import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { SeededRoleName } from '../src/common/enums/seeded-role-name.enum';
import { PrismaService } from '../src/prisma/prisma.service';
import { truncateAll } from './setup/db';
import {
  addMembership,
  createPlatformAdmin,
  createUser,
  createRegularUser,
  seedRbacCatalog,
  SeededUser,
} from './setup/rbac';
import { createTestApp } from './setup/test-app';

interface PageBody<T> {
  data: T[];
  meta: { total: number };
}
interface AuditLogUserRefBody {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  roles: string[];
}
interface AuditLogBody {
  id: string;
  action: string;
  actorId: string | null;
  targetUserId: string | null;
  metadata: Record<string, unknown> | null;
  actor: AuditLogUserRefBody | null;
  targetUser: AuditLogUserRefBody | null;
}

describe('Audit logs (e2e)', () => {
  let app: INestApplication<App>;
  let admin: SeededUser;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll(app);
    await seedRbacCatalog(app);
    admin = await createPlatformAdmin(app);
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * How many audit rows one `POST /businesses` writes.
   *
   * Two, deliberately: `business.created`, and the `business_membership.added`
   * event for the founding owner. The membership row is the business's first
   * tenure, and audit events are this template's membership history — see the
   * note on `BusinessMembership` in `schema.prisma` — so a founding owner with
   * no recorded join would be a hole in it.
   *
   * Named rather than inlined because several assertions below count "every row
   * this fixture produced", and a bare `2` in each of them says nothing about
   * why.
   */
  const AUDIT_ROWS_PER_BUSINESS_CREATION = 2;

  // Exercises the real write path: creating a business records `business.created`
  // plus the founding owner's join.
  const generateAuditRow = async (owner: SeededUser): Promise<void> => {
    await request(app.getHttpServer())
      .post('/api/businesses')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Acme', slug: 'acme' })
      .expect(201);
  };

  it('GET /api/audit-logs is denied to an ordinary user', async () => {
    const user = await createRegularUser(app, 'user@example.com');
    await request(app.getHttpServer())
      .get('/api/audit-logs')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(403);
  });

  it('PLATFORM_ADMIN can read the audit trail', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    await generateAuditRow(owner);

    const response = await request(app.getHttpServer())
      .get('/api/audit-logs')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const body = response.body as PageBody<AuditLogBody>;
    expect(body.data.some((row) => row.action === 'business.created')).toBe(
      true,
    );
  });

  it('PLATFORM_ENGINEER can read the audit trail (read AuditLog)', async () => {
    // The non-admin role that legitimately investigates. Engineers hold the
    // highest TECHNICAL authority and no governance, which is the shape the
    // audit trail is appropriate for.
    const engineer = await createUser(app, {
      email: 'engineer@example.com',
      roles: [SeededRoleName.PLATFORM_ENGINEER],
    });
    await request(app.getHttpServer())
      .get('/api/audit-logs')
      .set('Authorization', `Bearer ${engineer.token}`)
      .expect(200);
  });

  it.each([
    SeededRoleName.PLATFORM_TECHNICAL_SUPPORT,
    SeededRoleName.PLATFORM_APP_SUPPORT,
  ])('%s is DENIED the audit trail', async (roleName) => {
    // The trail carries IP addresses, user agents, parsed device fingerprints,
    // and — behind Cloudflare — geolocation, for every account on the platform.
    // Support roles are the most widely staffed on the platform and the least
    // appropriate default holders of that.
    //
    // A project that genuinely needs support-side visibility should add a
    // SANITIZED endpoint (whitelisted fields, restricted event types,
    // server-side filtering) rather than granting `read AuditLog`.
    const support = await createUser(app, {
      email: `${roleName}@example.com`,
      roles: [roleName],
    });
    await request(app.getHttpServer())
      .get('/api/audit-logs')
      .set('Authorization', `Bearer ${support.token}`)
      .expect(403);
  });

  it('filters by action and actorId', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    await generateAuditRow(owner);

    const byAction = await request(app.getHttpServer())
      .get('/api/audit-logs?action=business.created')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const actionBody = byAction.body as PageBody<AuditLogBody>;
    expect(actionBody.meta.total).toBe(1);
    expect(actionBody.data[0].actorId).toBe(owner.id);

    const byActor = await request(app.getHttpServer())
      .get(`/api/audit-logs?actorId=${owner.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    // Every row this actor produced, which is both of the creation's events.
    expect((byActor.body as PageBody<AuditLogBody>).meta.total).toBe(
      AUDIT_ROWS_PER_BUSINESS_CREATION,
    );

    const noMatch = await request(app.getHttpServer())
      .get('/api/audit-logs?action=does.not.exist')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect((noMatch.body as PageBody<AuditLogBody>).meta.total).toBe(0);
  });

  it('GET /api/audit-logs/:id returns a single row, and 404 for an unknown id', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    await generateAuditRow(owner);

    const prisma = app.get(PrismaService);
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'business.created' },
    });

    const response = await request(app.getHttpServer())
      .get(`/api/audit-logs/${row.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect((response.body as AuditLogBody).action).toBe('business.created');

    await request(app.getHttpServer())
      .get('/api/audit-logs/00000000-0000-4000-8000-000000000000')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(404);
  });

  describe('?search=', () => {
    // Every one of these returned ZERO before the search was rewritten:
    // Prisma's `{ metadata: { string_contains } }` is a JSON-path filter, so
    // against an object-valued metadata column it matched nothing and never
    // touched the pg_trgm GIN index the init migration ships for exactly this.
    it('matches a value inside the metadata envelope', async () => {
      const owner = await createRegularUser(app, 'owner@example.com');
      await generateAuditRow(owner);

      const response = await request(app.getHttpServer())
        .get('/api/audit-logs?search=acme')
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);
      const body = response.body as PageBody<AuditLogBody>;
      expect(body.meta.total).toBe(1);
      expect(body.data[0].action).toBe('business.created');
    });

    it('matches an action substring, case-insensitively', async () => {
      const owner = await createRegularUser(app, 'owner@example.com');
      await generateAuditRow(owner);

      const response = await request(app.getHttpServer())
        .get('/api/audit-logs?search=BUSINESS.CREA')
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);
      expect((response.body as PageBody<AuditLogBody>).meta.total).toBe(1);
    });

    // "Show me everything involving this person" — the most common forensic
    // question, and one neither an action nor a metadata match can answer.
    it("matches either party's email", async () => {
      const owner = await createRegularUser(app, 'searchable@example.com');
      await generateAuditRow(owner);

      const response = await request(app.getHttpServer())
        .get('/api/audit-logs?search=searchable@example.com')
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);
      const body = response.body as PageBody<AuditLogBody>;
      // The address matches on BOTH of the creation's events, since this person
      // is the actor on each.
      expect(body.meta.total).toBe(AUDIT_ROWS_PER_BUSINESS_CREATION);
      expect(body.data.every((row) => row.actorId === owner.id)).toBe(true);
    });

    it('returns nothing for a term that matches no signal', async () => {
      const owner = await createRegularUser(app, 'owner@example.com');
      await generateAuditRow(owner);

      const response = await request(app.getHttpServer())
        .get('/api/audit-logs?search=zzz-no-such-term')
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);
      expect((response.body as PageBody<AuditLogBody>).meta.total).toBe(0);
    });

    // An operator who passed an exact action key already knows what they want.
    it('lets an exact action filter win over search', async () => {
      const owner = await createRegularUser(app, 'owner@example.com');
      await generateAuditRow(owner);

      const response = await request(app.getHttpServer())
        .get('/api/audit-logs?action=does.not.exist&search=acme')
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);
      expect((response.body as PageBody<AuditLogBody>).meta.total).toBe(0);
    });
  });

  describe('createdAt range', () => {
    it('filters on both bounds, inclusively, and each bound alone', async () => {
      const owner = await createRegularUser(app, 'owner@example.com');
      await generateAuditRow(owner);

      const prisma = app.get(PrismaService);
      const row = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'business.created' },
      });
      const createdAt = row.createdAt.toISOString();
      const before = new Date(row.createdAt.getTime() - 60_000).toISOString();
      const after = new Date(row.createdAt.getTime() + 60_000).toISOString();

      // Pinned to ONE action, so this measures the range filter rather than how
      // many events a business creation happens to write. Without the pin, the
      // founding owner's join event lands microseconds after `row.createdAt` and
      // the exact-instant bound below becomes a coin flip on millisecond
      // rounding.
      const totalFor = async (queryString: string): Promise<number> => {
        const response = await request(app.getHttpServer())
          .get(`/api/audit-logs?action=business.created&${queryString}`)
          .set('Authorization', `Bearer ${admin.token}`)
          .expect(200);
        return (response.body as PageBody<AuditLogBody>).meta.total;
      };

      expect(
        await totalFor(`startCreatedAt=${before}&endCreatedAt=${after}`),
      ).toBe(1);
      expect(await totalFor(`startCreatedAt=${before}`)).toBe(1);
      expect(await totalFor(`endCreatedAt=${after}`)).toBe(1);
      // Both bounds are inclusive, so the row's own instant matches.
      expect(
        await totalFor(`startCreatedAt=${createdAt}&endCreatedAt=${createdAt}`),
      ).toBe(1);
      expect(await totalFor(`startCreatedAt=${after}`)).toBe(0);
      expect(await totalFor(`endCreatedAt=${before}`)).toBe(0);
    });

    // `createdAt` is a moment in time, so its bounds are strict UTC instants —
    // a zoneless string would otherwise be read against the server's clock.
    it('rejects a non-UTC bound with 400', async () => {
      for (const bound of [
        'startCreatedAt=2026-04-20T00:00:00',
        'startCreatedAt=2026-04-20T00:00:00%2B03:00',
        'endCreatedAt=not-a-date',
      ]) {
        await request(app.getHttpServer())
          .get(`/api/audit-logs?${bound}`)
          .set('Authorization', `Bearer ${admin.token}`)
          .expect(400);
      }
    });
  });

  describe('user hydration', () => {
    it('embeds the actor and target user so a client needs no second call', async () => {
      const user = await createRegularUser(app, 'target@example.com');
      const prisma = app.get(PrismaService);
      const supportRole = await prisma.role.findUniqueOrThrow({
        where: { name: SeededRoleName.PLATFORM_APP_SUPPORT },
      });

      await request(app.getHttpServer())
        .post(`/api/users/${user.id}/roles`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ roleId: supportRole.id })
        .expect(204);

      const response = await request(app.getHttpServer())
        .get('/api/audit-logs?action=user.role_assigned')
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);
      const [auditLog] = (response.body as PageBody<AuditLogBody>).data;

      expect(auditLog.actor).toMatchObject({ id: admin.id });
      expect(auditLog.targetUser).toMatchObject({
        id: user.id,
        email: 'target@example.com',
      });
      // Platform role names come along so an operator scanning a list can tell
      // who the actor is without a second call.
      expect(auditLog.actor?.roles).toContain(SeededRoleName.PLATFORM_ADMIN);

      // And this is the CURRENT-state caveat, made concrete: the target held NO
      // platform role when the action was recorded, and the role this very
      // audit row describes being granted is already in the list. The field
      // answers "who is this person now?", never "what were they allowed to do
      // at the time?" — for that, read `metadata`, which is point-in-time.
      expect(auditLog.targetUser?.roles).toEqual([
        SeededRoleName.PLATFORM_APP_SUPPORT,
      ]);
      // Narrow by construction — the hydrated ref must never carry the
      // credential columns that live on the same row.
      expect(auditLog.actor).not.toHaveProperty('password');
      expect(auditLog.actor).not.toHaveProperty('otp');
      expect(auditLog.actor).not.toHaveProperty('userRoles');
    });

    // The trail must not go anonymous once an account is closed — that is
    // precisely when someone is reading it.
    it('still names a soft-deleted user', async () => {
      const owner = await createRegularUser(app, 'closing@example.com');
      await generateAuditRow(owner);

      // Creating the business made this user its only owner, and an account
      // deletion that would strand a business is now refused. A co-owner is the
      // setup this test always implied — it is about the audit trail surviving a
      // closed account, not about who may close one.
      const business = await app
        .get(PrismaService)
        .business.findFirstOrThrow({ where: { slug: 'acme' } });
      const coOwner = await createRegularUser(app, 'remaining@example.com');
      await addMembership(
        app,
        business.id,
        coOwner.id,
        SeededRoleName.BUSINESS_OWNER,
      );

      await request(app.getHttpServer())
        .delete(`/api/users/${owner.id}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(204);

      const response = await request(app.getHttpServer())
        .get('/api/audit-logs?action=business.created')
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);
      const [auditLog] = (response.body as PageBody<AuditLogBody>).data;
      expect(auditLog.actor).toMatchObject({ id: owner.id });
    });

    // Explicit null rather than a missing key, so a client can branch on it.
    it('reports an unhydratable reference as null', async () => {
      const prisma = app.get(PrismaService);
      await prisma.auditLog.create({
        data: {
          action: 'system.maintenance_ran',
          metadata: { note: 'no actor' },
        },
      });

      const response = await request(app.getHttpServer())
        .get('/api/audit-logs?action=system.maintenance_ran')
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);
      const [auditLog] = (response.body as PageBody<AuditLogBody>).data;
      expect(auditLog.actor).toBeNull();
      expect(auditLog.targetUser).toBeNull();
    });

    it('hydrates on the single-row endpoint too', async () => {
      const owner = await createRegularUser(app, 'owner@example.com');
      await generateAuditRow(owner);

      const prisma = app.get(PrismaService);
      const row = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'business.created' },
      });

      const response = await request(app.getHttpServer())
        .get(`/api/audit-logs/${row.id}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);
      expect((response.body as AuditLogBody).actor).toMatchObject({
        id: owner.id,
      });
    });
  });

  it('records role assignment with the target user', async () => {
    const user = await createRegularUser(app, 'user@example.com');
    const prisma = app.get(PrismaService);
    const supportRole = await prisma.role.findUniqueOrThrow({
      where: { name: SeededRoleName.PLATFORM_APP_SUPPORT },
    });

    await request(app.getHttpServer())
      .post(`/api/users/${user.id}/roles`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ roleId: supportRole.id })
      .expect(204);

    const response = await request(app.getHttpServer())
      .get('/api/audit-logs?action=user.role_assigned')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const body = response.body as PageBody<AuditLogBody>;
    expect(body.meta.total).toBe(1);
    expect(body.data[0].actorId).toBe(admin.id);
    expect(body.data[0].targetUserId).toBe(user.id);
  });
});
