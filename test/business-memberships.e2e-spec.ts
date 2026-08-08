import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { BusinessMembershipStatus } from '../src/common/enums/business-membership-status.enum';
import { SeededRoleName } from '../src/common/enums/seeded-role-name.enum';
import { PrismaService } from '../src/prisma/prisma.service';
import { truncateAll } from './setup/db';
import {
  addMembership,
  createBusinessWithOwner,
  createPlatformAdmin,
  createRegularUser,
  roleIdFor,
  seedRbacCatalog,
  SeededBusiness,
  SeededUser,
} from './setup/rbac';
import { createTestApp } from './setup/test-app';

interface ErrorBody {
  errorCode: string;
}
interface MembershipBody {
  id: string;
  userId: string;
  status: BusinessMembershipStatus;
  notes: string | null;
  role: { name: string };
}
interface PageBody<T> {
  data: T[];
  meta: { total: number };
}

describe('Business memberships (e2e)', () => {
  let app: INestApplication<App>;
  let owner: SeededUser;
  let business: SeededBusiness;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll(app);
    await seedRbacCatalog(app);
    owner = await createRegularUser(app, 'owner@example.com');
    business = await createBusinessWithOwner(app, owner.id);
  });

  afterAll(async () => {
    await app.close();
  });

  const membershipsUrl = () => `/api/businesses/${business.id}/memberships`;

  describe('one role per business', () => {
    it('one account belongs to many businesses with a different role in each', async () => {
      const person = await createRegularUser(app, 'person@example.com');
      const second = await createBusinessWithOwner(app, owner.id, 'beta');
      const third = await createBusinessWithOwner(app, owner.id, 'gamma');

      await addMembership(
        app,
        business.id,
        person.id,
        SeededRoleName.BUSINESS_ADMIN,
      );
      await addMembership(
        app,
        second.id,
        person.id,
        SeededRoleName.BUSINESS_MEMBER,
      );
      await addMembership(
        app,
        third.id,
        person.id,
        SeededRoleName.BUSINESS_CUSTOMER,
      );

      const response = await request(app.getHttpServer())
        .get('/api/users/me/permissions')
        .set('Authorization', `Bearer ${person.token}`)
        .expect(200);

      const body = response.body as {
        businessMemberships: Array<{ businessId: string; roleName: string }>;
      };
      expect(
        body.businessMemberships.map((m) => [m.businessId, m.roleName]).sort(),
      ).toEqual(
        [
          [business.id, SeededRoleName.BUSINESS_ADMIN],
          [second.id, SeededRoleName.BUSINESS_MEMBER],
          [third.id, SeededRoleName.BUSINESS_CUSTOMER],
        ].sort(),
      );
    });

    it('refuses a second membership in the same business', async () => {
      const person = await createRegularUser(app, 'person@example.com');
      await addMembership(
        app,
        business.id,
        person.id,
        SeededRoleName.BUSINESS_MEMBER,
      );

      const response = await request(app.getHttpServer())
        .post(membershipsUrl())
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          email: person.email,
          roleId: await roleIdFor(app, SeededRoleName.BUSINESS_CUSTOMER),
        })
        .expect(409);

      expect((response.body as ErrorBody).errorCode).toBe('RESOURCE_CONFLICT');
    });

    it('re-joining after leaving reuses the SAME row', async () => {
      // `@@unique([businessId, userId])` is unconditional, so a second INSERT
      // is impossible by construction — the lifecycle has to move the existing
      // row back rather than create a new one.
      const person = await createRegularUser(app, 'person@example.com');
      const membershipId = await addMembership(
        app,
        business.id,
        person.id,
        SeededRoleName.BUSINESS_MEMBER,
        BusinessMembershipStatus.LEFT,
      );

      const response = await request(app.getHttpServer())
        .post(membershipsUrl())
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          email: person.email,
          roleId: await roleIdFor(app, SeededRoleName.BUSINESS_MEMBER),
        })
        .expect(201);

      expect((response.body as MembershipBody).id).toBe(membershipId);

      const prisma = app.get(PrismaService);
      const rows = await prisma.businessMembership.count({
        where: { businessId: business.id, userId: person.id },
      });
      expect(rows).toBe(1);
    });
  });

  describe('only ACTIVE memberships confer authority', () => {
    it.each([
      BusinessMembershipStatus.INVITED,
      BusinessMembershipStatus.SUSPENDED,
      BusinessMembershipStatus.LEFT,
    ])('a %s membership grants nothing', async (status) => {
      const person = await createRegularUser(app, 'person@example.com');
      await addMembership(
        app,
        business.id,
        person.id,
        SeededRoleName.BUSINESS_ADMIN,
        status,
      );

      // BUSINESS_ADMIN would grant `read Business` if the membership counted.
      await request(app.getHttpServer())
        .get(`/api/businesses/${business.id}`)
        .set('Authorization', `Bearer ${person.token}`)
        .expect(404);
    });

    it('a soft-deleted business grants nothing to its roster', async () => {
      const staff = await createRegularUser(app, 'staff@example.com');
      await addMembership(
        app,
        business.id,
        staff.id,
        SeededRoleName.BUSINESS_ADMIN,
      );

      await request(app.getHttpServer())
        .delete(`/api/businesses/${business.id}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(204);

      // An empty page rather than a 404, consistent with every other read in
      // this module: the status code must not become an oracle for whether a
      // business exists.
      //
      // The row itself still exists — memberships are retained through a
      // business soft-delete so a restore brings the roster back — so "empty"
      // here is a real assertion. Their business-scoped grants are gone, AND
      // the intrinsic own-membership read is filtered by business liveness;
      // without that second filter this returns their own row, notes included.
      const response = await request(app.getHttpServer())
        .get(membershipsUrl())
        .set('Authorization', `Bearer ${staff.token}`)
        .expect(200);
      expect((response.body as PageBody<MembershipBody>).data).toEqual([]);

      const prisma = app.get(PrismaService);
      expect(
        await prisma.businessMembership.count({
          where: { businessId: business.id },
        }),
      ).toBeGreaterThan(0);
    });
  });

  describe('tenant isolation', () => {
    it('a customer sees ONLY their own membership, never the roster', async () => {
      const customer = await createRegularUser(app, 'customer@example.com');
      await addMembership(
        app,
        business.id,
        customer.id,
        SeededRoleName.BUSINESS_CUSTOMER,
      );
      const staff = await createRegularUser(app, 'staff@example.com');
      await addMembership(
        app,
        business.id,
        staff.id,
        SeededRoleName.BUSINESS_MEMBER,
      );

      const response = await request(app.getHttpServer())
        .get(membershipsUrl())
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(200);

      const body = response.body as PageBody<MembershipBody>;
      // Exactly one row: their own. This is why the roster query goes through
      // AbilityScopedQueryService rather than filtering on businessId alone —
      // a customer holds only the intrinsic ownership-scoped read.
      expect(body.data.map((row) => row.userId)).toEqual([customer.id]);
    });

    it('a member of another business gets an empty page, not a 403', async () => {
      const other = await createRegularUser(app, 'other@example.com');
      const otherBusiness = await createBusinessWithOwner(
        app,
        other.id,
        'zeta',
      );
      void otherBusiness;

      const response = await request(app.getHttpServer())
        .get(membershipsUrl())
        .set('Authorization', `Bearer ${other.token}`)
        .expect(200);

      expect((response.body as PageBody<MembershipBody>).data).toEqual([]);
    });

    it('a businessId in the path cannot reach another tenant’s membership', async () => {
      const outsider = await createRegularUser(app, 'outsider@example.com');
      const outsiderBusiness = await createBusinessWithOwner(
        app,
        outsider.id,
        'omega',
      );
      const prisma = app.get(PrismaService);
      const victim = await prisma.businessMembership.findFirstOrThrow({
        where: { businessId: business.id },
      });

      // Their own tenant in the path, someone else's membership id in it.
      await request(app.getHttpServer())
        .get(`/api/businesses/${outsiderBusiness.id}/memberships/${victim.id}`)
        .set('Authorization', `Bearer ${outsider.token}`)
        .expect(404);
    });
  });

  describe('the rank ceiling', () => {
    let businessAdmin: SeededUser;

    beforeEach(async () => {
      businessAdmin = await createRegularUser(app, 'ba@example.com');
      await addMembership(
        app,
        business.id,
        businessAdmin.id,
        SeededRoleName.BUSINESS_ADMIN,
      );
    });

    it('an admin cannot mint an owner', async () => {
      const person = await createRegularUser(app, 'person@example.com');

      const response = await request(app.getHttpServer())
        .post(membershipsUrl())
        .set('Authorization', `Bearer ${businessAdmin.token}`)
        .send({
          email: person.email,
          roleId: await roleIdFor(app, SeededRoleName.BUSINESS_OWNER),
        })
        .expect(403);

      expect((response.body as ErrorBody).errorCode).toBe(
        'ROLE_NOT_ASSIGNABLE',
      );
    });

    it('an admin cannot promote ITSELF to owner', async () => {
      const prisma = app.get(PrismaService);
      const own = await prisma.businessMembership.findFirstOrThrow({
        where: { businessId: business.id, userId: businessAdmin.id },
      });

      await request(app.getHttpServer())
        .patch(`${membershipsUrl()}/${own.id}/role`)
        .set('Authorization', `Bearer ${businessAdmin.token}`)
        .send({ roleId: await roleIdFor(app, SeededRoleName.BUSINESS_OWNER) })
        .expect(403);
    });

    it('an admin cannot act on the owner, who outranks it', async () => {
      const prisma = app.get(PrismaService);
      const ownerMembership = await prisma.businessMembership.findFirstOrThrow({
        where: { businessId: business.id, userId: owner.id },
      });

      await request(app.getHttpServer())
        .delete(`${membershipsUrl()}/${ownerMembership.id}`)
        .set('Authorization', `Bearer ${businessAdmin.token}`)
        .expect(403);
    });

    it('an admin MAY appoint a peer admin — lateral is not escalation', async () => {
      const person = await createRegularUser(app, 'person@example.com');

      await request(app.getHttpServer())
        .post(membershipsUrl())
        .set('Authorization', `Bearer ${businessAdmin.token}`)
        .send({
          email: person.email,
          roleId: await roleIdFor(app, SeededRoleName.BUSINESS_ADMIN),
        })
        .expect(201);
    });

    it('rejects a PLATFORM-scoped role inside a business', async () => {
      const person = await createRegularUser(app, 'person@example.com');

      const response = await request(app.getHttpServer())
        .post(membershipsUrl())
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          email: person.email,
          roleId: await roleIdFor(app, SeededRoleName.PLATFORM_ADMIN),
        })
        .expect(403);

      expect((response.body as ErrorBody).errorCode).toBe(
        'ROLE_NOT_ASSIGNABLE',
      );
    });

    it('a platform role smuggled into a membership grants NOTHING', async () => {
      // The service refuses this with a clean 403. This asserts what happens if
      // a future code path forgets to ask — inserting the row directly, exactly
      // as a backfill script or a careless migration would.
      //
      // There is deliberately no database constraint blocking the write. The
      // guarantee lives in `AbilityFactory`, which refuses to compile a
      // permission whose scope does not match the branch it arrived in: one
      // place, both directions, and — unlike a CHECK — it also covers a grant
      // set arriving from the Redis cache.
      const prisma = app.get(PrismaService);
      const person = await createRegularUser(app, 'person@example.com');
      const platformAdminRoleId = await roleIdFor(
        app,
        SeededRoleName.PLATFORM_ADMIN,
      );

      await prisma.businessMembership.create({
        data: {
          businessId: business.id,
          userId: person.id,
          roleId: platformAdminRoleId,
          status: BusinessMembershipStatus.ACTIVE,
          joinedAt: new Date(),
        },
      });

      // `platform_admin` holds `manage all`. If this membership conferred it,
      // this person would own the platform.
      await request(app.getHttpServer())
        .get('/api/users')
        .set('Authorization', `Bearer ${person.token}`)
        .expect(403);
      await request(app.getHttpServer())
        .get(`/api/businesses/${business.id}`)
        .set('Authorization', `Bearer ${person.token}`)
        .expect(404);
    });

    it('a BUSINESS role smuggled platform-wide grants NOTHING', async () => {
      // The direction that actually escalates, and the reason the guard lives
      // in the ability factory rather than in the schema.
      //
      // Business permissions are always `ANY`, and the platform branch emits an
      // UNCONDITIONAL rule — so without the guard this is `read
      // BusinessMembership` across every tenant on the platform, with no
      // businessId condition at all.
      const prisma = app.get(PrismaService);
      const person = await createRegularUser(app, 'person@example.com');
      const businessAdminRoleId = await roleIdFor(
        app,
        SeededRoleName.BUSINESS_ADMIN,
      );

      await prisma.userRole.create({
        data: { userId: person.id, roleId: businessAdminRoleId },
      });

      const roster = await request(app.getHttpServer())
        .get(membershipsUrl())
        .set('Authorization', `Bearer ${person.token}`)
        .expect(200);
      expect((roster.body as PageBody<MembershipBody>).data).toEqual([]);

      await request(app.getHttpServer())
        .get(`/api/businesses/${business.id}`)
        .set('Authorization', `Bearer ${person.token}`)
        .expect(404);
    });
  });

  describe('ownership invariants', () => {
    const ownerMembership = async () => {
      const prisma = app.get(PrismaService);
      return prisma.businessMembership.findFirstOrThrow({
        where: { businessId: business.id, userId: owner.id },
      });
    };

    it('the last active owner cannot be removed', async () => {
      const membership = await ownerMembership();
      const response = await request(app.getHttpServer())
        .delete(`${membershipsUrl()}/${membership.id}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(409);

      expect((response.body as ErrorBody).errorCode).toBe(
        'LAST_OWNER_PROTECTED',
      );
    });

    it('the last active owner cannot be demoted', async () => {
      const membership = await ownerMembership();
      const response = await request(app.getHttpServer())
        .patch(`${membershipsUrl()}/${membership.id}/role`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ roleId: await roleIdFor(app, SeededRoleName.BUSINESS_ADMIN) })
        .expect(409);

      expect((response.body as ErrorBody).errorCode).toBe(
        'LAST_OWNER_PROTECTED',
      );
    });

    it('the last active owner cannot be suspended', async () => {
      const membership = await ownerMembership();
      await request(app.getHttpServer())
        .post(`${membershipsUrl()}/${membership.id}/suspend`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(409);
    });

    it('binds a PLATFORM_ADMIN too — it is data integrity, not authorization', async () => {
      // `manage all` bypasses the rank ceiling, which is an authorization
      // control. It must NOT bypass this one: an ownerless business is
      // unadministrable no matter who created that state.
      const platformAdmin = await createPlatformAdmin(app);
      const membership = await ownerMembership();

      await request(app.getHttpServer())
        .delete(`${membershipsUrl()}/${membership.id}`)
        .set('Authorization', `Bearer ${platformAdmin.token}`)
        .expect(409);
    });

    it('an owner may leave once a co-owner exists', async () => {
      const coOwner = await createRegularUser(app, 'co@example.com');
      await addMembership(
        app,
        business.id,
        coOwner.id,
        SeededRoleName.BUSINESS_OWNER,
      );

      const membership = await ownerMembership();
      await request(app.getHttpServer())
        .delete(`${membershipsUrl()}/${membership.id}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(204);

      const prisma = app.get(PrismaService);
      const refreshed = await prisma.businessMembership.findUniqueOrThrow({
        where: { id: membership.id },
      });
      // Ended, not deleted — the row is what keeps the uniqueness invariant
      // unconditional, and the relationship is history worth keeping.
      expect(refreshed.status).toBe(BusinessMembershipStatus.LEFT);
      expect(refreshed.endedAt).not.toBeNull();
    });

    it('a suspended owner does not count toward the invariant', async () => {
      // The subtle one: rank 100 on paper, no authority in fact. If the count
      // ignored status, suspending one owner and removing the other would leave
      // the business ownerless.
      const coOwner = await createRegularUser(app, 'co@example.com');
      const coOwnerMembershipId = await addMembership(
        app,
        business.id,
        coOwner.id,
        SeededRoleName.BUSINESS_OWNER,
        BusinessMembershipStatus.SUSPENDED,
      );
      void coOwnerMembershipId;

      const membership = await ownerMembership();
      await request(app.getHttpServer())
        .delete(`${membershipsUrl()}/${membership.id}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(409);
    });

    it('concurrent demotions cannot race a business to zero owners', async () => {
      const coOwner = await createRegularUser(app, 'co@example.com');
      await addMembership(
        app,
        business.id,
        coOwner.id,
        SeededRoleName.BUSINESS_OWNER,
      );

      const prisma = app.get(PrismaService);
      const [first, second] = await prisma.businessMembership.findMany({
        where: {
          businessId: business.id,
          role: { name: SeededRoleName.BUSINESS_OWNER },
        },
        orderBy: { createdAt: 'asc' },
      });
      const adminRoleId = await roleIdFor(app, SeededRoleName.BUSINESS_ADMIN);

      // Both owners demoted at the same instant. The business-row lock
      // serialises them, so the second sees a committed count of one.
      const results = await Promise.all([
        request(app.getHttpServer())
          .patch(`${membershipsUrl()}/${first.id}/role`)
          .set('Authorization', `Bearer ${owner.token}`)
          .send({ roleId: adminRoleId }),
        request(app.getHttpServer())
          .patch(`${membershipsUrl()}/${second.id}/role`)
          .set('Authorization', `Bearer ${coOwner.token}`)
          .send({ roleId: adminRoleId }),
      ]);

      const statuses = results.map((response) => response.status).sort();
      expect(statuses).toEqual([200, 409]);

      // The assertion that actually matters — read from the database, not from
      // the status codes, so an atomicity regression cannot pass by luck.
      const remainingOwners = await prisma.businessMembership.count({
        where: {
          businessId: business.id,
          status: BusinessMembershipStatus.ACTIVE,
          role: { name: SeededRoleName.BUSINESS_OWNER },
        },
      });
      expect(remainingOwners).toBe(1);
    });
  });

  describe('ownership transfer', () => {
    it('promotes the target and demotes the acting owner, atomically', async () => {
      const successor = await createRegularUser(app, 'successor@example.com');
      const membershipId = await addMembership(
        app,
        business.id,
        successor.id,
        SeededRoleName.BUSINESS_ADMIN,
      );

      await request(app.getHttpServer())
        .post(`${membershipsUrl()}/${membershipId}/transfer-ownership`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      const prisma = app.get(PrismaService);
      const rows = await prisma.businessMembership.findMany({
        where: { businessId: business.id },
        include: { role: { select: { name: true } } },
      });
      const byUser = new Map(rows.map((row) => [row.userId, row.role.name]));
      expect(byUser.get(successor.id)).toBe(SeededRoleName.BUSINESS_OWNER);
      expect(byUser.get(owner.id)).toBe(SeededRoleName.BUSINESS_ADMIN);
      // Never zero, never two. `role.name` is a plain `String` column; cast at
      // the boundary before comparing against the TS enum.
      expect(
        rows.filter(
          (row) =>
            (row.role.name as SeededRoleName) === SeededRoleName.BUSINESS_OWNER,
        ),
      ).toHaveLength(1);
    });

    it('a business admin cannot transfer ownership', async () => {
      const businessAdmin = await createRegularUser(app, 'ba@example.com');
      const membershipId = await addMembership(
        app,
        business.id,
        businessAdmin.id,
        SeededRoleName.BUSINESS_ADMIN,
      );

      await request(app.getHttpServer())
        .post(`${membershipsUrl()}/${membershipId}/transfer-ownership`)
        .set('Authorization', `Bearer ${businessAdmin.token}`)
        .expect(403);
    });

    it('demotes the INCUMBENT owner when a platform admin transfers', async () => {
      // Regression: the demotion used to key off the ACTOR's own membership.
      // A platform admin holds `manage all` and no membership, so nothing was
      // demoted and the business came out of a "transfer" with TWO owners —
      // while the audit line claimed ownership had moved.
      const platformAdmin = await createPlatformAdmin(app);
      const successor = await createRegularUser(app, 'successor@example.com');
      const membershipId = await addMembership(
        app,
        business.id,
        successor.id,
        SeededRoleName.BUSINESS_MEMBER,
      );

      await request(app.getHttpServer())
        .post(`${membershipsUrl()}/${membershipId}/transfer-ownership`)
        .set('Authorization', `Bearer ${platformAdmin.token}`)
        .expect(200);

      const prisma = app.get(PrismaService);
      const owners = await prisma.businessMembership.findMany({
        where: {
          businessId: business.id,
          status: BusinessMembershipStatus.ACTIVE,
          role: { name: SeededRoleName.BUSINESS_OWNER },
        },
      });
      expect(owners).toHaveLength(1);
      expect(owners[0].userId).toBe(successor.id);
    });

    it('refuses to transfer to a non-active membership', async () => {
      const successor = await createRegularUser(app, 'successor@example.com');
      const membershipId = await addMembership(
        app,
        business.id,
        successor.id,
        SeededRoleName.BUSINESS_MEMBER,
        BusinessMembershipStatus.SUSPENDED,
      );

      const response = await request(app.getHttpServer())
        .post(`${membershipsUrl()}/${membershipId}/transfer-ownership`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(409);

      expect((response.body as ErrorBody).errorCode).toBe(
        'MEMBERSHIP_NOT_ACTIVE',
      );
    });
  });

  describe('removing an INVITED membership cancels it', () => {
    it('deletes the placeholder rather than 500ing on the joined_at CHECK', async () => {
      // Regression: `remove()` routed every status through the same transition,
      // writing status='left' with `joinedAt` still NULL. That violates
      // `business_memberships_joined_at_check`, and Postgres 23514 is not one
      // of the Prisma codes the global filter translates — so a routine roster
      // action answered 500 INTERNAL_ERROR and wrote no audit row.
      const invitee = await createRegularUser(app, 'invitee@example.com');
      const membershipId = await addMembership(
        app,
        business.id,
        invitee.id,
        SeededRoleName.BUSINESS_MEMBER,
        BusinessMembershipStatus.INVITED,
      );

      await request(app.getHttpServer())
        .delete(`${membershipsUrl()}/${membershipId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(204);

      // An INVITED row is a reservation, not history — cancelling frees the
      // slot so the address can be invited again.
      const prisma = app.get(PrismaService);
      expect(
        await prisma.businessMembership.count({
          where: { businessId: business.id, userId: invitee.id },
        }),
      ).toBe(0);
    });
  });

  describe('staff annotations', () => {
    it('a member cannot write notes on their own membership', async () => {
      const person = await createRegularUser(app, 'person@example.com');
      const membershipId = await addMembership(
        app,
        business.id,
        person.id,
        SeededRoleName.BUSINESS_CUSTOMER,
      );

      await request(app.getHttpServer())
        .patch(`${membershipsUrl()}/${membershipId}`)
        .set('Authorization', `Bearer ${person.token}`)
        .send({ notes: 'I am a VIP' })
        .expect(403);
    });

    it('staff may annotate, and the note persists', async () => {
      const person = await createRegularUser(app, 'person@example.com');
      const membershipId = await addMembership(
        app,
        business.id,
        person.id,
        SeededRoleName.BUSINESS_CUSTOMER,
      );

      const response = await request(app.getHttpServer())
        .patch(`${membershipsUrl()}/${membershipId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ notes: 'Allergic to nuts' })
        .expect(200);

      expect((response.body as MembershipBody).notes).toBe('Allergic to nuts');
    });
  });
});
