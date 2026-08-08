import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { SeededRoleName } from '../src/common/enums/seeded-role-name.enum';
import { PrismaService } from '../src/prisma/prisma.service';
import { truncateAll } from './setup/db';
import {
  addMembership,
  createBusinessWithOwner,
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

/**
 * Who may hand out which role.
 *
 * `BUSINESS_MANAGER` holds `create BusinessMembership` and `create
 * BusinessInvitation`, and deliberately NOT `assignRole BusinessMembership` —
 * the catalog describes them as able to "grow the roster but not assign roles".
 * Only the first half of that was true: the rank ceiling compares with `>`, and
 * rank 40 is not greater than rank 40, so a manager could appoint a peer
 * manager, who could appoint another.
 *
 * The bound that closes it is an allowlist, so a business role added to the
 * catalog tomorrow is privileged by default rather than silently handable-out.
 */
describe('Business role assignment authority (e2e)', () => {
  let app: INestApplication<App>;
  let owner: SeededUser;
  let manager: SeededUser;
  let business: SeededBusiness;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll(app);
    await seedRbacCatalog(app);
    owner = await createRegularUser(app, 'owner@example.com');
    business = await createBusinessWithOwner(app, owner.id);
    manager = await createRegularUser(app, 'manager@example.com');
    await addMembership(
      app,
      business.id,
      manager.id,
      SeededRoleName.BUSINESS_MANAGER,
    );
  });

  afterAll(async () => {
    await app.close();
  });

  const membershipsUrl = () => `/api/businesses/${business.id}/memberships`;
  const invitationsUrl = () => `/api/businesses/${business.id}/invitations`;

  const PRIVILEGED_ROLES = [
    SeededRoleName.BUSINESS_MANAGER,
    SeededRoleName.BUSINESS_ADMIN,
    SeededRoleName.BUSINESS_OWNER,
  ];
  const NON_PRIVILEGED_ROLES = [
    SeededRoleName.BUSINESS_MEMBER,
    SeededRoleName.BUSINESS_CUSTOMER,
  ];

  describe('adding to the roster', () => {
    it.each(PRIVILEGED_ROLES)('a manager cannot add a %s', async (roleName) => {
      const newcomer = await createRegularUser(app, 'newcomer@example.com');

      const response = await request(app.getHttpServer())
        .post(membershipsUrl())
        .set('Authorization', `Bearer ${manager.token}`)
        .send({
          email: newcomer.email,
          roleId: await roleIdFor(app, roleName),
        })
        .expect(403);

      expect((response.body as ErrorBody).errorCode).toBe(
        'ROLE_NOT_ASSIGNABLE',
      );
      expect(
        await app.get(PrismaService).businessMembership.count({
          where: { businessId: business.id, userId: newcomer.id },
        }),
      ).toBe(0);
    });

    it.each(NON_PRIVILEGED_ROLES)(
      'a manager may add a %s',
      async (roleName) => {
        const newcomer = await createRegularUser(app, 'newcomer@example.com');

        await request(app.getHttpServer())
          .post(membershipsUrl())
          .set('Authorization', `Bearer ${manager.token}`)
          .send({
            email: newcomer.email,
            roleId: await roleIdFor(app, roleName),
          })
          .expect(201);
      },
    );
  });

  describe('inviting', () => {
    it.each(PRIVILEGED_ROLES)(
      'a manager cannot invite a %s',
      async (roleName) => {
        // An invitation IS a role assignment, merely deferred. Enforcing this
        // only on the roster path would make the rule whichever endpoint the
        // caller picked.
        const response = await request(app.getHttpServer())
          .post(invitationsUrl())
          .set('Authorization', `Bearer ${manager.token}`)
          .send({
            email: 'stranger@example.com',
            roleId: await roleIdFor(app, roleName),
          })
          .expect(403);

        expect((response.body as ErrorBody).errorCode).toBe(
          'ROLE_NOT_ASSIGNABLE',
        );
        expect(
          await app.get(PrismaService).businessInvitation.count({
            where: { businessId: business.id },
          }),
        ).toBe(0);
      },
    );

    it.each(NON_PRIVILEGED_ROLES)(
      'a manager may invite a %s',
      async (roleName) => {
        await request(app.getHttpServer())
          .post(invitationsUrl())
          .set('Authorization', `Bearer ${manager.token}`)
          .send({
            email: 'stranger@example.com',
            roleId: await roleIdFor(app, roleName),
          })
          .expect(201);
      },
    );
  });

  describe('a caller WITH assignRole is still bounded by rank', () => {
    it('an admin cannot appoint an owner', async () => {
      // BUSINESS_ADMIN (rank 70) holds `assignRole`, so the allowlist does not
      // apply — the ceiling does, and BUSINESS_OWNER is rank 100.
      const admin = await createRegularUser(app, 'admin@example.com');
      await addMembership(
        app,
        business.id,
        admin.id,
        SeededRoleName.BUSINESS_ADMIN,
      );
      const newcomer = await createRegularUser(app, 'newcomer@example.com');

      const response = await request(app.getHttpServer())
        .post(membershipsUrl())
        .set('Authorization', `Bearer ${admin.token}`)
        .send({
          email: newcomer.email,
          roleId: await roleIdFor(app, SeededRoleName.BUSINESS_OWNER),
        })
        .expect(403);

      expect((response.body as ErrorBody).errorCode).toBe(
        'ROLE_NOT_ASSIGNABLE',
      );
    });

    it('an admin may appoint a peer admin', async () => {
      // The behaviour the manager case ONLY looks like: holding `assignRole` is
      // what makes appointing a peer legitimate, not the rank comparison alone.
      const admin = await createRegularUser(app, 'admin@example.com');
      await addMembership(
        app,
        business.id,
        admin.id,
        SeededRoleName.BUSINESS_ADMIN,
      );
      const newcomer = await createRegularUser(app, 'newcomer@example.com');

      await request(app.getHttpServer())
        .post(membershipsUrl())
        .set('Authorization', `Bearer ${admin.token}`)
        .send({
          email: newcomer.email,
          roleId: await roleIdFor(app, SeededRoleName.BUSINESS_ADMIN),
        })
        .expect(201);
    });
  });

  describe('resending re-checks authority', () => {
    it('refuses once the inviter has been demoted', async () => {
      // The invitation was legitimate when raised. A resend re-issues the same
      // role, so it is re-checked against what the actor may do NOW.
      const admin = await createRegularUser(app, 'admin@example.com');
      const adminMembershipId = await addMembership(
        app,
        business.id,
        admin.id,
        SeededRoleName.BUSINESS_ADMIN,
      );
      const created = await request(app.getHttpServer())
        .post(invitationsUrl())
        .set('Authorization', `Bearer ${admin.token}`)
        .send({
          email: 'stranger@example.com',
          roleId: await roleIdFor(app, SeededRoleName.BUSINESS_ADMIN),
        })
        .expect(201);
      const invitationId = (created.body as { id: string }).id;

      await request(app.getHttpServer())
        .patch(`${membershipsUrl()}/${adminMembershipId}/role`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ roleId: await roleIdFor(app, SeededRoleName.BUSINESS_MANAGER) })
        .expect(200);

      const response = await request(app.getHttpServer())
        .post(`${invitationsUrl()}/${invitationId}/resend`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(403);
      expect((response.body as ErrorBody).errorCode).toBe(
        'ROLE_NOT_ASSIGNABLE',
      );
    });
  });
});
