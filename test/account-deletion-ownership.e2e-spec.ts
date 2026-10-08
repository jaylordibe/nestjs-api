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
  seedRbacCatalog,
  TEST_PASSWORD,
} from './setup/rbac';
import { createTestApp } from './setup/test-app';

/**
 * The ownership invariant, enforced from the ACCOUNT side.
 *
 * Membership routes have guarded "a live workspace keeps an active owner" for a
 * while. Account deletion did not, and it is the easier way to break it: delete
 * the sole owner and the workspace is left with an ACTIVE WORKSPACE_OWNER
 * membership pointing at a dead user. Every roster read filters on a live user,
 * so that row is invisible — and `WORKSPACE_ADMIN` holds no `transferOwnership`,
 * so nobody inside the tenant can repair what nobody inside the tenant can see.
 */
describe('Account deletion cannot orphan a workspace (e2e)', () => {
  let app: INestApplication<App>;

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

  const liveOwnerCount = async (workspaceId: string): Promise<number> =>
    app.get(PrismaService).workspaceMembership.count({
      where: {
        workspaceId,
        status: WorkspaceMembershipStatus.ACTIVE,
        role: { name: SeededRoleName.WORKSPACE_OWNER },
        user: { deletedAt: null },
      },
    });

  const workspaceIsLive = async (workspaceId: string): Promise<boolean> => {
    const workspace = await app
      .get(PrismaService)
      .workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    return workspace.deletedAt === null;
  };

  describe('self-close: DELETE /users/me', () => {
    it('refuses while the caller is the only owner, and names the workspace', async () => {
      const owner = await createRegularUser(app, 'sole@example.com');
      const workspace = await createWorkspaceWithOwner(
        app,
        owner.id,
        'sole-co',
      );

      const response = await request(app.getHttpServer())
        .delete('/api/users/me')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(409);

      const body = response.body as {
        errorCode: string;
        details: { workspaces: { id: string; name: string }[] };
      };
      expect(body.errorCode).toBe('LAST_OWNER_PROTECTED');
      // Named, because the caller cannot otherwise tell WHICH workspace is
      // blocking them, and the remedy is theirs to carry out.
      expect(body.details.workspaces).toEqual([
        { id: workspace.id, name: 'sole-co' },
      ]);

      const prisma = app.get(PrismaService);
      const stillLive = await prisma.user.findUniqueOrThrow({
        where: { id: owner.id },
      });
      expect(stillLive.deletedAt).toBeNull();
    });

    it('allows the close once a co-owner exists', async () => {
      const owner = await createRegularUser(app, 'leaving@example.com');
      const coOwner = await createRegularUser(app, 'staying@example.com');
      const workspace = await createWorkspaceWithOwner(app, owner.id, 'duo-co');
      await addMembership(
        app,
        workspace.id,
        coOwner.id,
        SeededRoleName.WORKSPACE_OWNER,
      );

      await request(app.getHttpServer())
        .delete('/api/users/me')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(204);

      expect(await liveOwnerCount(workspace.id)).toBe(1);
      expect(await workspaceIsLive(workspace.id)).toBe(true);
    });

    it('is not satisfied by a co-owner whose account is already gone', async () => {
      // The phantom-owner case. A soft-deleted owner still has an ACTIVE
      // WORKSPACE_OWNER row; counting it would let the last live owner walk out.
      const owner = await createRegularUser(app, 'live@example.com');
      const departed = await createRegularUser(app, 'departed@example.com');
      const workspace = await createWorkspaceWithOwner(
        app,
        owner.id,
        'ghost-co',
      );
      await addMembership(
        app,
        workspace.id,
        departed.id,
        SeededRoleName.WORKSPACE_OWNER,
      );
      await app.get(PrismaService).user.update({
        where: { id: departed.id },
        data: { deletedAt: new Date() },
      });

      await request(app.getHttpServer())
        .delete('/api/users/me')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(409);

      expect(await liveOwnerCount(workspace.id)).toBe(1);
    });

    it('ignores a workspace that is already closed', async () => {
      // A soft-deleted workspace has nothing left to administer, so sole
      // ownership of one must not hold an account hostage forever.
      const owner = await createRegularUser(app, 'closed@example.com');
      const workspace = await createWorkspaceWithOwner(
        app,
        owner.id,
        'shut-co',
      );
      await app.get(PrismaService).workspace.update({
        where: { id: workspace.id },
        data: { deletedAt: new Date() },
      });

      await request(app.getHttpServer())
        .delete('/api/users/me')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(204);
    });

    it('ignores a membership that is suspended or ended', async () => {
      // Neither grants authority, so neither is an owner for this purpose.
      const owner = await createRegularUser(app, 'suspended@example.com');
      const workspace = await createWorkspaceWithOwner(
        app,
        owner.id,
        'susp-co',
      );
      await app.get(PrismaService).workspaceMembership.updateMany({
        where: { workspaceId: workspace.id, userId: owner.id },
        data: { status: WorkspaceMembershipStatus.SUSPENDED },
      });

      await request(app.getHttpServer())
        .delete('/api/users/me')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(204);
    });
  });

  describe('administrative delete: DELETE /users/:id', () => {
    it('refuses for a platform admin too', async () => {
      // `manage all` bypasses AUTHORIZATION, not data integrity. An admin who
      // could delete a sole owner would create the one broken state no
      // workspace-level actor can see or repair.
      const admin = await createPlatformAdmin(app);
      const owner = await createRegularUser(app, 'target@example.com');
      const workspace = await createWorkspaceWithOwner(
        app,
        owner.id,
        'admin-co',
      );

      const response = await request(app.getHttpServer())
        .delete(`/api/users/${owner.id}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(409);

      expect((response.body as { errorCode: string }).errorCode).toBe(
        'LAST_OWNER_PROTECTED',
      );
      expect(await liveOwnerCount(workspace.id)).toBe(1);
    });
  });

  describe('erasure: POST /users/me/gdpr-erase', () => {
    it('closes the solely-owned workspace instead of refusing', async () => {
      // Erasure answers a legal obligation, so it cannot be declined because of
      // a commercial relationship. The workspace is closed in the same
      // transaction — never left ownerless, never left live.
      const owner = await createRegularUser(app, 'erase@example.com');
      const workspace = await createWorkspaceWithOwner(
        app,
        owner.id,
        'erase-co',
      );

      await request(app.getHttpServer())
        .post('/api/users/me/gdpr-erase')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ currentPassword: TEST_PASSWORD })
        .expect(204);

      expect(await workspaceIsLive(workspace.id)).toBe(false);

      const erased = await app
        .get(PrismaService)
        .user.findUniqueOrThrow({ where: { id: owner.id } });
      expect(erased.deletedAt).not.toBeNull();
      expect(erased.email).toBe(`deleted-${owner.id}@deleted.invalid`);
    });

    it('leaves a co-owned workspace open', async () => {
      const owner = await createRegularUser(app, 'goer@example.com');
      const coOwner = await createRegularUser(app, 'keeper@example.com');
      const workspace = await createWorkspaceWithOwner(
        app,
        owner.id,
        'shared-co',
      );
      await addMembership(
        app,
        workspace.id,
        coOwner.id,
        SeededRoleName.WORKSPACE_OWNER,
      );

      await request(app.getHttpServer())
        .post('/api/users/me/gdpr-erase')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ currentPassword: TEST_PASSWORD })
        .expect(204);

      expect(await workspaceIsLive(workspace.id)).toBe(true);
      expect(await liveOwnerCount(workspace.id)).toBe(1);
    });

    it('records only workspace ids, never their names', async () => {
      // A single-proprietor tenant's workspace name IS personal data. Writing it
      // into the audit trail during an erasure re-creates what the erasure just
      // removed.
      const owner = await createRegularUser(app, 'audited@example.com');
      const workspace = await createWorkspaceWithOwner(
        app,
        owner.id,
        'audited-co',
      );

      await request(app.getHttpServer())
        .post('/api/users/me/gdpr-erase')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ currentPassword: TEST_PASSWORD })
        .expect(204);

      const auditEntry = await app
        .get(PrismaService)
        .auditLog.findFirstOrThrow({
          where: { action: 'user.gdpr_erased', targetUserId: owner.id },
        });
      const serialized = JSON.stringify(auditEntry.metadata);
      expect(serialized).toContain(workspace.id);
      expect(serialized).not.toContain('audited-co');
    });
  });

  describe('concurrency', () => {
    it('two co-owners deleting simultaneously leaves one owner standing', async () => {
      // Without the workspace-row lock taken between the two ownership reads,
      // each transaction sees the other as the surviving owner and both
      // proceed — the textbook read-then-write race, and the reason the lock is
      // inside the policy rather than left to callers.
      const first = await createRegularUser(app, 'first@example.com');
      const second = await createRegularUser(app, 'second@example.com');
      const workspace = await createWorkspaceWithOwner(
        app,
        first.id,
        'race-co',
      );
      await addMembership(
        app,
        workspace.id,
        second.id,
        SeededRoleName.WORKSPACE_OWNER,
      );

      const responses = await Promise.all([
        request(app.getHttpServer())
          .delete('/api/users/me')
          .set('Authorization', `Bearer ${first.token}`),
        request(app.getHttpServer())
          .delete('/api/users/me')
          .set('Authorization', `Bearer ${second.token}`),
      ]);

      // Asserted on rows, not status codes: exactly one owner must remain,
      // whichever request happened to win.
      expect(await liveOwnerCount(workspace.id)).toBe(1);
      expect(responses.map((response) => response.status).sort()).toEqual([
        204, 409,
      ]);
    });

    it('a deletion racing the co-owner’s demotion leaves one owner standing', async () => {
      const owner = await createRegularUser(app, 'quitter@example.com');
      const coOwner = await createRegularUser(app, 'demoted@example.com');
      const workspace = await createWorkspaceWithOwner(
        app,
        owner.id,
        'demote-co',
      );
      const coOwnerMembershipId = await addMembership(
        app,
        workspace.id,
        coOwner.id,
        SeededRoleName.WORKSPACE_OWNER,
      );
      const admin = await createPlatformAdmin(app);
      const prisma = app.get(PrismaService);
      const memberRole = await prisma.role.findUniqueOrThrow({
        where: { name: SeededRoleName.WORKSPACE_STAFF },
      });

      await Promise.all([
        request(app.getHttpServer())
          .delete('/api/users/me')
          .set('Authorization', `Bearer ${owner.token}`),
        request(app.getHttpServer())
          .patch(
            `/api/workspaces/${workspace.id}/memberships/${coOwnerMembershipId}/role`,
          )
          .set('Authorization', `Bearer ${admin.token}`)
          .send({ roleId: memberRole.id }),
      ]);

      expect(await liveOwnerCount(workspace.id)).toBe(1);
    });
  });
});
