import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { WorkspaceMembershipStatus } from '../src/common/enums/workspace-membership-status.enum';
import { SeededRoleName } from '../src/common/enums/seeded-role-name.enum';
import { PrismaService } from '../src/prisma/prisma.service';
import { truncateAll } from './setup/db';
import {
  addMembership,
  createWorkspaceWithOwner,
  createPlatformAdmin,
  createRegularUser,
  roleIdFor,
  seedRbacCatalog,
  SeededWorkspace,
  SeededUser,
} from './setup/rbac';
import { createTestApp } from './setup/test-app';

interface ErrorBody {
  errorCode: string;
}
interface MembershipBody {
  id: string;
  userId: string;
  status: WorkspaceMembershipStatus;
  notes: string | null;
  role: { name: string };
}
interface PageBody<T> {
  data: T[];
  meta: { total: number };
}

describe('Workspace memberships (e2e)', () => {
  let app: INestApplication<App>;
  let owner: SeededUser;
  let workspace: SeededWorkspace;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll(app);
    await seedRbacCatalog(app);
    owner = await createRegularUser(app, 'owner@example.com');
    workspace = await createWorkspaceWithOwner(app, owner.id);
  });

  afterAll(async () => {
    await app.close();
  });

  const membershipsUrl = () => `/api/workspaces/${workspace.id}/memberships`;

  describe('one role per workspace', () => {
    it('one account belongs to many workspaces with a different role in each', async () => {
      const person = await createRegularUser(app, 'person@example.com');
      const second = await createWorkspaceWithOwner(app, owner.id, 'beta');
      const third = await createWorkspaceWithOwner(app, owner.id, 'gamma');

      await addMembership(
        app,
        workspace.id,
        person.id,
        SeededRoleName.WORKSPACE_ADMIN,
      );
      await addMembership(
        app,
        second.id,
        person.id,
        SeededRoleName.WORKSPACE_MEMBER,
      );
      await addMembership(
        app,
        third.id,
        person.id,
        SeededRoleName.WORKSPACE_MANAGER,
      );

      const response = await request(app.getHttpServer())
        .get('/api/users/me/permissions')
        .set('Authorization', `Bearer ${person.token}`)
        .expect(200);

      const body = response.body as {
        workspaceMemberships: Array<{ workspaceId: string; roleName: string }>;
      };
      expect(
        body.workspaceMemberships
          .map((m) => [m.workspaceId, m.roleName])
          .sort(),
      ).toEqual(
        [
          [workspace.id, SeededRoleName.WORKSPACE_ADMIN],
          [second.id, SeededRoleName.WORKSPACE_MEMBER],
          [third.id, SeededRoleName.WORKSPACE_MANAGER],
        ].sort(),
      );
    });

    it('refuses a second membership in the same workspace', async () => {
      const person = await createRegularUser(app, 'person@example.com');
      await addMembership(
        app,
        workspace.id,
        person.id,
        SeededRoleName.WORKSPACE_MEMBER,
      );

      const response = await request(app.getHttpServer())
        .post(membershipsUrl())
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          email: person.email,
          roleId: await roleIdFor(app, SeededRoleName.WORKSPACE_MANAGER),
        })
        .expect(409);

      expect((response.body as ErrorBody).errorCode).toBe('RESOURCE_CONFLICT');
    });

    it('re-joining after leaving reuses the SAME row', async () => {
      // `@@unique([workspaceId, userId])` is unconditional, so a second INSERT
      // is impossible by construction — the lifecycle has to move the existing
      // row back rather than create a new one.
      const person = await createRegularUser(app, 'person@example.com');
      const membershipId = await addMembership(
        app,
        workspace.id,
        person.id,
        SeededRoleName.WORKSPACE_MEMBER,
        WorkspaceMembershipStatus.LEFT,
      );

      const response = await request(app.getHttpServer())
        .post(membershipsUrl())
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          email: person.email,
          roleId: await roleIdFor(app, SeededRoleName.WORKSPACE_MEMBER),
        })
        .expect(201);

      expect((response.body as MembershipBody).id).toBe(membershipId);

      const prisma = app.get(PrismaService);
      const rows = await prisma.workspaceMembership.count({
        where: { workspaceId: workspace.id, userId: person.id },
      });
      expect(rows).toBe(1);
    });
  });

  describe('only ACTIVE memberships confer authority', () => {
    it.each([
      WorkspaceMembershipStatus.SUSPENDED,
      WorkspaceMembershipStatus.LEFT,
    ])('a %s membership grants nothing', async (status) => {
      const person = await createRegularUser(app, 'person@example.com');
      await addMembership(
        app,
        workspace.id,
        person.id,
        SeededRoleName.WORKSPACE_ADMIN,
        status,
      );

      // WORKSPACE_ADMIN would grant `read Workspace` if the membership counted.
      await request(app.getHttpServer())
        .get(`/api/workspaces/${workspace.id}`)
        .set('Authorization', `Bearer ${person.token}`)
        .expect(404);
    });

    it('a soft-deleted workspace grants nothing to its roster', async () => {
      const staff = await createRegularUser(app, 'staff@example.com');
      await addMembership(
        app,
        workspace.id,
        staff.id,
        SeededRoleName.WORKSPACE_ADMIN,
      );

      await request(app.getHttpServer())
        .delete(`/api/workspaces/${workspace.id}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(204);

      // An empty page rather than a 404, consistent with every other read in
      // this module: the status code must not become an oracle for whether a
      // workspace exists.
      //
      // The row itself still exists — memberships are retained through a
      // workspace soft-delete so a restore brings the roster back — so "empty"
      // here is a real assertion. Their workspace-scoped grants are gone, AND
      // the intrinsic own-membership read is filtered by workspace liveness;
      // without that second filter this returns their own row, notes included.
      const response = await request(app.getHttpServer())
        .get(membershipsUrl())
        .set('Authorization', `Bearer ${staff.token}`)
        .expect(200);
      expect((response.body as PageBody<MembershipBody>).data).toEqual([]);

      const prisma = app.get(PrismaService);
      expect(
        await prisma.workspaceMembership.count({
          where: { workspaceId: workspace.id },
        }),
      ).toBeGreaterThan(0);
    });
  });

  describe('tenant isolation', () => {
    it('a member of another workspace gets an empty page, not a 403', async () => {
      const other = await createRegularUser(app, 'other@example.com');
      const otherWorkspace = await createWorkspaceWithOwner(
        app,
        other.id,
        'zeta',
      );
      void otherWorkspace;

      const response = await request(app.getHttpServer())
        .get(membershipsUrl())
        .set('Authorization', `Bearer ${other.token}`)
        .expect(200);

      expect((response.body as PageBody<MembershipBody>).data).toEqual([]);
    });

    it('a workspaceId in the path cannot reach another tenant’s membership', async () => {
      const outsider = await createRegularUser(app, 'outsider@example.com');
      const outsiderWorkspace = await createWorkspaceWithOwner(
        app,
        outsider.id,
        'omega',
      );
      const prisma = app.get(PrismaService);
      const victim = await prisma.workspaceMembership.findFirstOrThrow({
        where: { workspaceId: workspace.id },
      });

      // Their own tenant in the path, someone else's membership id in it.
      await request(app.getHttpServer())
        .get(`/api/workspaces/${outsiderWorkspace.id}/memberships/${victim.id}`)
        .set('Authorization', `Bearer ${outsider.token}`)
        .expect(404);
    });
  });

  describe('the rank ceiling', () => {
    let workspaceAdmin: SeededUser;

    beforeEach(async () => {
      workspaceAdmin = await createRegularUser(app, 'ba@example.com');
      await addMembership(
        app,
        workspace.id,
        workspaceAdmin.id,
        SeededRoleName.WORKSPACE_ADMIN,
      );
    });

    it('an admin cannot mint an owner', async () => {
      const person = await createRegularUser(app, 'person@example.com');

      const response = await request(app.getHttpServer())
        .post(membershipsUrl())
        .set('Authorization', `Bearer ${workspaceAdmin.token}`)
        .send({
          email: person.email,
          roleId: await roleIdFor(app, SeededRoleName.WORKSPACE_OWNER),
        })
        .expect(403);

      expect((response.body as ErrorBody).errorCode).toBe(
        'ROLE_NOT_ASSIGNABLE',
      );
    });

    it('an admin cannot promote ITSELF to owner', async () => {
      const prisma = app.get(PrismaService);
      const own = await prisma.workspaceMembership.findFirstOrThrow({
        where: { workspaceId: workspace.id, userId: workspaceAdmin.id },
      });

      await request(app.getHttpServer())
        .patch(`${membershipsUrl()}/${own.id}/role`)
        .set('Authorization', `Bearer ${workspaceAdmin.token}`)
        .send({ roleId: await roleIdFor(app, SeededRoleName.WORKSPACE_OWNER) })
        .expect(403);
    });

    it('an admin cannot act on the owner, who outranks it', async () => {
      const prisma = app.get(PrismaService);
      const ownerMembership = await prisma.workspaceMembership.findFirstOrThrow(
        {
          where: { workspaceId: workspace.id, userId: owner.id },
        },
      );

      await request(app.getHttpServer())
        .delete(`${membershipsUrl()}/${ownerMembership.id}`)
        .set('Authorization', `Bearer ${workspaceAdmin.token}`)
        .expect(403);
    });

    it('an admin MAY appoint a peer admin — lateral is not escalation', async () => {
      const person = await createRegularUser(app, 'person@example.com');

      await request(app.getHttpServer())
        .post(membershipsUrl())
        .set('Authorization', `Bearer ${workspaceAdmin.token}`)
        .send({
          email: person.email,
          roleId: await roleIdFor(app, SeededRoleName.WORKSPACE_ADMIN),
        })
        .expect(201);
    });

    it('rejects a PLATFORM-scoped role inside a workspace', async () => {
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

      await prisma.workspaceMembership.create({
        data: {
          workspaceId: workspace.id,
          userId: person.id,
          roleId: platformAdminRoleId,
          status: WorkspaceMembershipStatus.ACTIVE,
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
        .get(`/api/workspaces/${workspace.id}`)
        .set('Authorization', `Bearer ${person.token}`)
        .expect(404);
    });

    it('a WORKSPACE role smuggled platform-wide grants NOTHING', async () => {
      // The direction that actually escalates, and the reason the guard lives
      // in the ability factory rather than in the schema.
      //
      // Workspace permissions are always `ANY`, and the platform branch emits an
      // UNCONDITIONAL rule — so without the guard this is `read
      // WorkspaceMembership` across every tenant on the platform, with no
      // workspaceId condition at all.
      const prisma = app.get(PrismaService);
      const person = await createRegularUser(app, 'person@example.com');
      const workspaceAdminRoleId = await roleIdFor(
        app,
        SeededRoleName.WORKSPACE_ADMIN,
      );

      await prisma.userRole.create({
        data: { userId: person.id, roleId: workspaceAdminRoleId },
      });

      const roster = await request(app.getHttpServer())
        .get(membershipsUrl())
        .set('Authorization', `Bearer ${person.token}`)
        .expect(200);
      expect((roster.body as PageBody<MembershipBody>).data).toEqual([]);

      await request(app.getHttpServer())
        .get(`/api/workspaces/${workspace.id}`)
        .set('Authorization', `Bearer ${person.token}`)
        .expect(404);
    });
  });

  describe('ownership invariants', () => {
    const ownerMembership = async () => {
      const prisma = app.get(PrismaService);
      return prisma.workspaceMembership.findFirstOrThrow({
        where: { workspaceId: workspace.id, userId: owner.id },
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
        .send({ roleId: await roleIdFor(app, SeededRoleName.WORKSPACE_ADMIN) })
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
      // control. It must NOT bypass this one: an ownerless workspace is
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
        workspace.id,
        coOwner.id,
        SeededRoleName.WORKSPACE_OWNER,
      );

      const membership = await ownerMembership();
      await request(app.getHttpServer())
        .delete(`${membershipsUrl()}/${membership.id}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(204);

      const prisma = app.get(PrismaService);
      const refreshed = await prisma.workspaceMembership.findUniqueOrThrow({
        where: { id: membership.id },
      });
      // Ended, not deleted — the row is what keeps the uniqueness invariant
      // unconditional, and the relationship is history worth keeping.
      expect(refreshed.status).toBe(WorkspaceMembershipStatus.LEFT);
      expect(refreshed.endedAt).not.toBeNull();
    });

    it('a suspended owner does not count toward the invariant', async () => {
      // The subtle one: rank 100 on paper, no authority in fact. If the count
      // ignored status, suspending one owner and removing the other would leave
      // the workspace ownerless.
      const coOwner = await createRegularUser(app, 'co@example.com');
      const coOwnerMembershipId = await addMembership(
        app,
        workspace.id,
        coOwner.id,
        SeededRoleName.WORKSPACE_OWNER,
        WorkspaceMembershipStatus.SUSPENDED,
      );
      void coOwnerMembershipId;

      const membership = await ownerMembership();
      await request(app.getHttpServer())
        .delete(`${membershipsUrl()}/${membership.id}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(409);
    });

    it('concurrent demotions cannot race a workspace to zero owners', async () => {
      const coOwner = await createRegularUser(app, 'co@example.com');
      await addMembership(
        app,
        workspace.id,
        coOwner.id,
        SeededRoleName.WORKSPACE_OWNER,
      );

      const prisma = app.get(PrismaService);
      const [first, second] = await prisma.workspaceMembership.findMany({
        where: {
          workspaceId: workspace.id,
          role: { name: SeededRoleName.WORKSPACE_OWNER },
        },
        orderBy: { createdAt: 'asc' },
      });
      const adminRoleId = await roleIdFor(app, SeededRoleName.WORKSPACE_ADMIN);

      // Both owners demoted at the same instant. The workspace-row lock
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
      const remainingOwners = await prisma.workspaceMembership.count({
        where: {
          workspaceId: workspace.id,
          status: WorkspaceMembershipStatus.ACTIVE,
          role: { name: SeededRoleName.WORKSPACE_OWNER },
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
        workspace.id,
        successor.id,
        SeededRoleName.WORKSPACE_ADMIN,
      );

      await request(app.getHttpServer())
        .post(`${membershipsUrl()}/${membershipId}/transfer-ownership`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      const prisma = app.get(PrismaService);
      const rows = await prisma.workspaceMembership.findMany({
        where: { workspaceId: workspace.id },
        include: { role: { select: { name: true } } },
      });
      const byUser = new Map(rows.map((row) => [row.userId, row.role.name]));
      expect(byUser.get(successor.id)).toBe(SeededRoleName.WORKSPACE_OWNER);
      expect(byUser.get(owner.id)).toBe(SeededRoleName.WORKSPACE_ADMIN);
      // Never zero, never two. `role.name` is a plain `String` column; cast at
      // the boundary before comparing against the TS enum.
      expect(
        rows.filter(
          (row) =>
            (row.role.name as SeededRoleName) ===
            SeededRoleName.WORKSPACE_OWNER,
        ),
      ).toHaveLength(1);
    });

    it('a workspace admin cannot transfer ownership', async () => {
      const workspaceAdmin = await createRegularUser(app, 'ba@example.com');
      const membershipId = await addMembership(
        app,
        workspace.id,
        workspaceAdmin.id,
        SeededRoleName.WORKSPACE_ADMIN,
      );

      await request(app.getHttpServer())
        .post(`${membershipsUrl()}/${membershipId}/transfer-ownership`)
        .set('Authorization', `Bearer ${workspaceAdmin.token}`)
        .expect(403);
    });

    it('demotes the INCUMBENT owner when a platform admin transfers', async () => {
      // Regression: the demotion used to key off the ACTOR's own membership.
      // A platform admin holds `manage all` and no membership, so nothing was
      // demoted and the workspace came out of a "transfer" with TWO owners —
      // while the audit line claimed ownership had moved.
      const platformAdmin = await createPlatformAdmin(app);
      const successor = await createRegularUser(app, 'successor@example.com');
      const membershipId = await addMembership(
        app,
        workspace.id,
        successor.id,
        SeededRoleName.WORKSPACE_MEMBER,
      );

      await request(app.getHttpServer())
        .post(`${membershipsUrl()}/${membershipId}/transfer-ownership`)
        .set('Authorization', `Bearer ${platformAdmin.token}`)
        .expect(200);

      const prisma = app.get(PrismaService);
      const owners = await prisma.workspaceMembership.findMany({
        where: {
          workspaceId: workspace.id,
          status: WorkspaceMembershipStatus.ACTIVE,
          role: { name: SeededRoleName.WORKSPACE_OWNER },
        },
      });
      expect(owners).toHaveLength(1);
      expect(owners[0].userId).toBe(successor.id);
    });

    it('refuses to transfer to a non-active membership', async () => {
      const successor = await createRegularUser(app, 'successor@example.com');
      const membershipId = await addMembership(
        app,
        workspace.id,
        successor.id,
        SeededRoleName.WORKSPACE_MEMBER,
        WorkspaceMembershipStatus.SUSPENDED,
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

  describe('a pending invitation writes no membership row', () => {
    it('leaves a former member\u2019s history untouched', async () => {
      // The placeholder this replaces consumed the ONE row
      // `@@unique([workspaceId, userId])` allows, so inviting a former member
      // back overwrote their `joinedAt` and `endedAt` \u2014 a manager could
      // rewrite somebody's employment history by sending an invitation, before
      // that person had accepted anything.
      const formerMember = await createRegularUser(app, 'former@example.com');
      const membershipId = await addMembership(
        app,
        workspace.id,
        formerMember.id,
        SeededRoleName.WORKSPACE_MEMBER,
        WorkspaceMembershipStatus.LEFT,
      );
      const prisma = app.get(PrismaService);
      const before = await prisma.workspaceMembership.findUniqueOrThrow({
        where: { id: membershipId },
      });

      await request(app.getHttpServer())
        .post(`/api/workspaces/${workspace.id}/invitations`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          email: formerMember.email,
          roleId: await roleIdFor(app, SeededRoleName.WORKSPACE_ADMIN),
        })
        .expect(201);

      const after = await prisma.workspaceMembership.findUniqueOrThrow({
        where: { id: membershipId },
      });
      expect(after.status).toBe(WorkspaceMembershipStatus.LEFT);
      expect(after.joinedAt).toEqual(before.joinedAt);
      expect(after.endedAt).toEqual(before.endedAt);
      expect(after.roleId).toBe(before.roleId);
    });
  });

  describe('staff annotations', () => {
    it('a member cannot write notes on their own membership', async () => {
      const person = await createRegularUser(app, 'person@example.com');
      const membershipId = await addMembership(
        app,
        workspace.id,
        person.id,
        SeededRoleName.WORKSPACE_MEMBER,
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
        workspace.id,
        person.id,
        SeededRoleName.WORKSPACE_MEMBER,
      );

      const response = await request(app.getHttpServer())
        .patch(`${membershipsUrl()}/${membershipId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ notes: 'Allergic to nuts' })
        .expect(200);

      expect((response.body as MembershipBody).notes).toBe('Allergic to nuts');
    });
  });

  /**
   * The membership row is CURRENT STATE; `audit_logs` is the history.
   *
   * One row per (workspace, user) forever is what makes "exactly one current role
   * per person per workspace" a database constraint. The trade is that re-joining
   * overwrites `joinedAt`, `endedAt`, `status`, and `roleId` in place — so the
   * previous tenure has to survive somewhere else, or it is simply lost. These
   * assert both halves: still one row, and the overwritten tenure recorded.
   */
  describe('membership history lives in the audit trail', () => {
    it('re-joining reuses the one row and records the tenure it replaced', async () => {
      const prisma = app.get(PrismaService);
      const returner = await createRegularUser(app, 'returner@example.com');
      const membershipId = await addMembership(
        app,
        workspace.id,
        returner.id,
        SeededRoleName.WORKSPACE_MEMBER,
      );
      const firstTenure = await prisma.workspaceMembership.findUniqueOrThrow({
        where: { id: membershipId },
        select: { joinedAt: true },
      });

      await request(app.getHttpServer())
        .delete(`${membershipsUrl()}/${membershipId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(204);

      const rejoined = await request(app.getHttpServer())
        .post(membershipsUrl())
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          email: returner.email,
          roleId: await roleIdFor(app, SeededRoleName.WORKSPACE_ADMIN),
        })
        .expect(201);

      // Still exactly one CURRENT membership — no duplicate, and the same row.
      expect((rejoined.body as MembershipBody).id).toBe(membershipId);
      expect(
        await prisma.workspaceMembership.count({
          where: { workspaceId: workspace.id, userId: returner.id },
        }),
      ).toBe(1);

      // The row now describes only the new tenure…
      const currentTenure = await prisma.workspaceMembership.findUniqueOrThrow({
        where: { id: membershipId },
        select: {
          joinedAt: true,
          endedAt: true,
          role: { select: { name: true } },
        },
      });
      expect(currentTenure.endedAt).toBeNull();
      expect(currentTenure.role.name).toBe(SeededRoleName.WORKSPACE_ADMIN);
      expect(currentTenure.joinedAt.getTime()).toBeGreaterThan(
        firstTenure.joinedAt.getTime(),
      );

      // …and the one it replaced is in the audit trail, which is the ONLY place
      // it still exists.
      const rejoinEvent = await prisma.auditLog.findFirstOrThrow({
        where: {
          action: 'workspace_membership.added',
          targetUserId: returner.id,
        },
        orderBy: { createdAt: 'desc' },
      });
      const metadata = rejoinEvent.metadata as {
        isRejoin?: boolean;
        previousTenure?: {
          status?: string;
          roleName?: string;
          endedAt?: string;
        };
      };
      expect(metadata.isRejoin).toBe(true);
      expect(metadata.previousTenure?.status).toBe(
        WorkspaceMembershipStatus.LEFT,
      );
      expect(metadata.previousTenure?.roleName).toBe(
        SeededRoleName.WORKSPACE_MEMBER,
      );
      expect(metadata.previousTenure?.endedAt).not.toBeNull();

      // The departure is recorded too, so the closed tenure is reconstructible
      // from both ends.
      const endedEvent = await prisma.auditLog.findFirst({
        where: {
          action: 'workspace_membership.ended',
          targetUserId: returner.id,
        },
      });
      expect(endedEvent).not.toBeNull();
    });

    it('a first join is recorded as a join, not a re-join', async () => {
      const prisma = app.get(PrismaService);
      const newcomer = await createRegularUser(app, 'newcomer@example.com');

      await request(app.getHttpServer())
        .post(membershipsUrl())
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          email: newcomer.email,
          roleId: await roleIdFor(app, SeededRoleName.WORKSPACE_MEMBER),
        })
        .expect(201);

      const event = await prisma.auditLog.findFirstOrThrow({
        where: {
          action: 'workspace_membership.added',
          targetUserId: newcomer.id,
        },
      });
      const metadata = event.metadata as {
        isRejoin?: boolean;
        previousTenure?: unknown;
      };
      expect(metadata.isRejoin).toBe(false);
      expect(metadata.previousTenure).toBeNull();
    });

    it('the founding owner membership is audited as a join', async () => {
      const prisma = app.get(PrismaService);
      const founder = await createRegularUser(app, 'founder@example.com');

      const created = await request(app.getHttpServer())
        .post('/api/workspaces')
        .set('Authorization', `Bearer ${founder.token}`)
        .send({ name: 'Founded Co', slug: 'founded-co' })
        .expect(201);
      const createdWorkspaceId = (created.body as { id: string }).id;

      // Every workspace starts with exactly one tenure — its owner's. Without
      // this event that one has no recorded beginning, which makes the audit
      // trail an unreliable history precisely for the most important role.
      const event = await prisma.auditLog.findFirstOrThrow({
        where: {
          action: 'workspace_membership.added',
          targetUserId: founder.id,
        },
      });
      const metadata = event.metadata as {
        workspaceId?: string;
        roleName?: string;
        isFoundingOwner?: boolean;
      };
      expect(metadata.workspaceId).toBe(createdWorkspaceId);
      expect(metadata.roleName).toBe(SeededRoleName.WORKSPACE_OWNER);
      expect(metadata.isFoundingOwner).toBe(true);
    });
  });
});
