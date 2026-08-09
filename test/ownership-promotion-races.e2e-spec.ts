import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { BusinessMembershipStatus } from '../src/common/enums/business-membership-status.enum';
import { SeededRoleName } from '../src/common/enums/seeded-role-name.enum';
import { AbilityFactory } from '../src/modules/authorization/ability.factory';
import { PermissionLoaderService } from '../src/modules/authorization/permission-loader.service';
import { BusinessOwnershipPolicy } from '../src/modules/businesses/business-ownership.policy';
import { BusinessInvitationsService } from '../src/modules/businesses/invitations/business-invitations.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { pauseBefore, runRace } from './setup/barrier';
import { truncateAll } from './setup/db';
import {
  addMembership,
  createBusinessWithOwner,
  createPlatformAdmin,
  createRegularUser,
  roleIdFor,
  seedRbacCatalog,
  TEST_PASSWORD,
  type SeededUser,
} from './setup/rbac';
import { createTestApp } from './setup/test-app';

/**
 * Ownership survives every race between promotion and account withdrawal.
 *
 * The invariant, stated once: **every live business has at least one ACTIVE
 * owner whose account is live and active.** Enforcing its two halves with
 * mechanisms that cannot see each other breaks it: if account deletion locks
 * only the businesses the user is ALREADY known to own, a promotion into a
 * business the user does not yet own locks nothing the deletion waits on, and
 * both commit. The result is an ACTIVE `BUSINESS_OWNER` membership pointing
 * at a dead account — invisible to every roster read (they all filter on a live
 * user), and unrepairable by any business-level actor, because `BUSINESS_ADMIN`
 * holds no `transferOwnership`.
 *
 * The fix is one lock order — user row, then business row, per
 * `src/common/util/row-lock.util.ts` — taken by BOTH sides, plus a re-read of
 * the target user inside the mutation. Every path that accepts a `roleId` is a
 * potential owner-creation path, so every one of them is exercised here.
 *
 * Races are driven by `test/setup/barrier.ts`, pausing at
 * `assertUserMayHoldActiveMembership` — the first lock the mutation takes, and
 * therefore the point at which everything it read beforehand is stale.
 *
 * Every case asserts the DATABASE invariant directly at the end: whatever the
 * two requests each returned, the business is either closed or still has an
 * owner who can act.
 */
describe('Ownership promotion races (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let ownershipPolicy: BusinessOwnershipPolicy;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    ownershipPolicy = app.get(BusinessOwnershipPolicy);
  });

  beforeEach(async () => {
    await truncateAll(app);
    await seedRbacCatalog(app);
  });

  afterAll(async () => {
    await app.close();
  });

  // ── the invariant, asserted against the database ─────────────────────────

  /**
   * THE assertion. Not "did the request 409" — that is a symptom. This is the
   * property the whole design exists to hold.
   */
  const assertEveryLiveBusinessHasAUsableOwner = async (): Promise<void> => {
    const liveBusinesses = await prisma.business.findMany({
      where: { deletedAt: null },
      select: { id: true, slug: true },
    });
    for (const business of liveBusinesses) {
      const usableOwners = await prisma.businessMembership.count({
        where: {
          businessId: business.id,
          status: BusinessMembershipStatus.ACTIVE,
          role: { name: SeededRoleName.BUSINESS_OWNER },
          user: { deletedAt: null, isActive: true },
        },
      });
      expect({ slug: business.slug, usableOwners }).toEqual({
        slug: business.slug,
        usableOwners: expect.any(Number) as number,
      });
      expect(usableOwners).toBeGreaterThanOrEqual(1);
    }
  };

  const pausePromotion = () =>
    pauseBefore(ownershipPolicy, 'assertUserMayHoldActiveMembership');

  const activeOwnerCount = (businessId: string) =>
    prisma.businessMembership.count({
      where: {
        businessId,
        status: BusinessMembershipStatus.ACTIVE,
        role: { name: SeededRoleName.BUSINESS_OWNER },
      },
    });

  interface Tenant {
    owner: SeededUser;
    business: { id: string; slug: string };
  }

  /** A business with one owner, plus an admin who can be promoted. */
  const seedTenant = async (slug = 'acme'): Promise<Tenant> => {
    const owner = await createRegularUser(app, `owner-${slug}@example.com`);
    const business = await createBusinessWithOwner(app, owner.id, slug);
    return { owner, business };
  };

  const membershipIdOf = async (businessId: string, userId: string) => {
    const membership = await prisma.businessMembership.findUniqueOrThrow({
      where: { businessId_userId: { businessId, userId } },
      select: { id: true },
    });
    return membership.id;
  };

  /**
   * Mints an invitation and returns its plaintext token.
   *
   * Through the service, because `POST /businesses/:id/invitations` deliberately
   * does not return the token — being able to invite an address must not also
   * let you redeem the invitation yourself. The service is the only place the
   * plaintext exists, and the ability handed to it is the REAL compiled one, so
   * it sees exactly what a request would give it.
   */
  const mintInvitationToken = async (
    businessId: string,
    actorId: string,
    email: string,
    roleId: string,
  ): Promise<string> => {
    const loader = app.get(PermissionLoaderService);
    const ability = app
      .get(AbilityFactory)
      .createForUser(actorId, await loader.loadGrants(actorId));
    const { token } = await app
      .get(BusinessInvitationsService)
      .create(businessId, { email, roleId }, ability, actorId);
    return token;
  };

  // ── promotion racing withdrawal of the account being promoted ────────────

  describe('promotion racing the target account being withdrawn', () => {
    it('ownership transfer racing deletion of the incoming owner', async () => {
      const { owner, business } = await seedTenant();
      const admin = await createPlatformAdmin(app);
      const successor = await createRegularUser(app, 'successor@example.com');
      await addMembership(
        app,
        business.id,
        successor.id,
        SeededRoleName.BUSINESS_ADMIN,
      );
      const successorMembershipId = await membershipIdOf(
        business.id,
        successor.id,
      );

      // The sharp case: after a transfer the successor is the SOLE owner, so
      // "delete the successor" and "transfer to the successor" cannot both win.
      const paused = pausePromotion();
      await runRace(
        request(app.getHttpServer())
          .post(
            `/api/businesses/${business.id}/memberships/${successorMembershipId}/transfer-ownership`,
          )
          .set('Authorization', `Bearer ${owner.token}`),
        paused,
        () =>
          request(app.getHttpServer())
            .delete(`/api/users/${successor.id}`)
            .set('Authorization', `Bearer ${admin.token}`),
      );

      await assertEveryLiveBusinessHasAUsableOwner();
    });

    it('ownership transfer racing GDPR erasure of the incoming owner', async () => {
      const { owner, business } = await seedTenant();
      const successor = await createRegularUser(app, 'successor@example.com');
      await addMembership(
        app,
        business.id,
        successor.id,
        SeededRoleName.BUSINESS_ADMIN,
      );
      const successorMembershipId = await membershipIdOf(
        business.id,
        successor.id,
      );

      const paused = pausePromotion();
      await runRace(
        request(app.getHttpServer())
          .post(
            `/api/businesses/${business.id}/memberships/${successorMembershipId}/transfer-ownership`,
          )
          .set('Authorization', `Bearer ${owner.token}`),
        paused,
        () =>
          request(app.getHttpServer())
            .post('/api/users/me/gdpr-erase')
            .set('Authorization', `Bearer ${successor.token}`)
            .send({ currentPassword: TEST_PASSWORD }),
      );

      await assertEveryLiveBusinessHasAUsableOwner();
    });

    it('role change to owner racing deletion of the target', async () => {
      const { owner, business } = await seedTenant();
      const admin = await createPlatformAdmin(app);
      const member = await createRegularUser(app, 'member@example.com');
      await addMembership(
        app,
        business.id,
        member.id,
        SeededRoleName.BUSINESS_MEMBER,
      );
      const memberMembershipId = await membershipIdOf(business.id, member.id);
      const ownerRoleId = await roleIdFor(app, SeededRoleName.BUSINESS_OWNER);

      const paused = pausePromotion();
      const outcome = await runRace(
        request(app.getHttpServer())
          .patch(
            `/api/businesses/${business.id}/memberships/${memberMembershipId}/role`,
          )
          .set('Authorization', `Bearer ${owner.token}`)
          .send({ roleId: ownerRoleId }),
        paused,
        () =>
          request(app.getHttpServer())
            .delete(`/api/users/${member.id}`)
            .set('Authorization', `Bearer ${admin.token}`),
      );

      // The deletion wins the user lock, so the promotion must find the account
      // gone. A 404 is the right answer — the same one an unknown user gets.
      const promotion =
        outcome.paused.status === 'fulfilled' ? outcome.paused.value : null;
      expect(promotion?.status).toBe(404);

      // No ACTIVE owner membership was created on the dead account.
      const deadOwnerRows = await prisma.businessMembership.count({
        where: {
          userId: member.id,
          status: BusinessMembershipStatus.ACTIVE,
          role: { name: SeededRoleName.BUSINESS_OWNER },
        },
      });
      expect(deadOwnerRows).toBe(0);
      await assertEveryLiveBusinessHasAUsableOwner();
    });

    it('direct owner-membership creation racing deletion of the target', async () => {
      const { owner, business } = await seedTenant();
      const admin = await createPlatformAdmin(app);
      const newcomer = await createRegularUser(app, 'newcomer@example.com');
      const ownerRoleId = await roleIdFor(app, SeededRoleName.BUSINESS_OWNER);

      const paused = pausePromotion();
      const outcome = await runRace(
        request(app.getHttpServer())
          .post(`/api/businesses/${business.id}/memberships`)
          .set('Authorization', `Bearer ${owner.token}`)
          .send({ email: newcomer.email, roleId: ownerRoleId }),
        paused,
        () =>
          request(app.getHttpServer())
            .delete(`/api/users/${newcomer.id}`)
            .set('Authorization', `Bearer ${admin.token}`),
      );

      const creation =
        outcome.paused.status === 'fulfilled' ? outcome.paused.value : null;
      expect(creation?.status).toBe(404);
      const memberships = await prisma.businessMembership.count({
        where: { userId: newcomer.id },
      });
      expect(memberships).toBe(0);
      await assertEveryLiveBusinessHasAUsableOwner();
    });

    it('owner reactivation racing deletion of the target', async () => {
      const { owner, business } = await seedTenant();
      const admin = await createPlatformAdmin(app);
      const suspendedOwner = await createRegularUser(
        app,
        'benched@example.com',
      );
      await addMembership(
        app,
        business.id,
        suspendedOwner.id,
        SeededRoleName.BUSINESS_OWNER,
        BusinessMembershipStatus.SUSPENDED,
      );
      const suspendedMembershipId = await membershipIdOf(
        business.id,
        suspendedOwner.id,
      );

      const paused = pausePromotion();
      const outcome = await runRace(
        request(app.getHttpServer())
          .post(
            `/api/businesses/${business.id}/memberships/${suspendedMembershipId}/reactivate`,
          )
          .set('Authorization', `Bearer ${owner.token}`),
        paused,
        () =>
          request(app.getHttpServer())
            .delete(`/api/users/${suspendedOwner.id}`)
            .set('Authorization', `Bearer ${admin.token}`),
      );

      // Reactivation re-creates an owner, so it races deletion exactly the way
      // a promotion does — a suspended membership is not a safe harbour.
      const reactivation =
        outcome.paused.status === 'fulfilled' ? outcome.paused.value : null;
      expect(reactivation?.status).toBe(404);
      const revived = await prisma.businessMembership.findUniqueOrThrow({
        where: { id: suspendedMembershipId },
        select: { status: true },
      });
      expect(revived.status).toBe(BusinessMembershipStatus.SUSPENDED);
      await assertEveryLiveBusinessHasAUsableOwner();
    });

    it('invitation acceptance into an owner role racing deletion of the invitee', async () => {
      const { owner, business } = await seedTenant();
      const admin = await createPlatformAdmin(app);
      const invitee = await createRegularUser(app, 'invitee@example.com');
      const ownerRoleId = await roleIdFor(app, SeededRoleName.BUSINESS_OWNER);

      // Minted through the service, not the endpoint: `POST /invitations`
      // deliberately never returns the plaintext token — it goes to the invited
      // address and nowhere else. The acceptance below still goes over HTTP.
      const token = await mintInvitationToken(
        business.id,
        owner.id,
        invitee.email,
        ownerRoleId,
      );

      const paused = pausePromotion();
      const outcome = await runRace(
        request(app.getHttpServer())
          .post('/api/invitations/accept')
          .set('Authorization', `Bearer ${invitee.token}`)
          .send({ token }),
        paused,
        () =>
          request(app.getHttpServer())
            .delete(`/api/users/${invitee.id}`)
            .set('Authorization', `Bearer ${admin.token}`),
      );

      const acceptance =
        outcome.paused.status === 'fulfilled' ? outcome.paused.value : null;
      expect(acceptance?.status).toBe(404);
      expect(
        await prisma.businessMembership.count({
          where: { userId: invitee.id },
        }),
      ).toBe(0);
      // The invitation must not have been consumed by a failed acceptance.
      const stillPending = await prisma.businessInvitation.findFirstOrThrow({
        where: { businessId: business.id },
        select: { status: true },
      });
      expect(stillPending.status).toBe('pending');
      await assertEveryLiveBusinessHasAUsableOwner();
    });
  });

  // ── withdrawal racing withdrawal ─────────────────────────────────────────

  describe('two withdrawals racing each other', () => {
    it('two co-owners deleting simultaneously leaves one behind', async () => {
      const { owner: first, business } = await seedTenant();
      const second = await createRegularUser(app, 'second-owner@example.com');
      await addMembership(
        app,
        business.id,
        second.id,
        SeededRoleName.BUSINESS_OWNER,
      );
      expect(await activeOwnerCount(business.id)).toBe(2);

      // No barrier seam here — both requests go through the same lock on
      // DIFFERENT user rows, so the serialization point is the business row.
      // Issued together on purpose: whichever order Postgres picks, exactly one
      // must be refused.
      const [firstOutcome, secondOutcome] = await Promise.allSettled([
        request(app.getHttpServer())
          .delete('/api/users/me')
          .set('Authorization', `Bearer ${first.token}`),
        request(app.getHttpServer())
          .delete('/api/users/me')
          .set('Authorization', `Bearer ${second.token}`),
      ]);

      const statuses = [firstOutcome, secondOutcome].map((outcome) =>
        outcome.status === 'fulfilled' ? outcome.value.status : 0,
      );
      expect(statuses.filter((status) => status === 204)).toHaveLength(1);
      expect(statuses.filter((status) => status === 409)).toHaveLength(1);
      await assertEveryLiveBusinessHasAUsableOwner();
    });

    it('two owners demoted simultaneously leaves one behind', async () => {
      const { owner: first, business } = await seedTenant();
      const second = await createRegularUser(app, 'second-owner@example.com');
      await addMembership(
        app,
        business.id,
        second.id,
        SeededRoleName.BUSINESS_OWNER,
      );
      const firstMembershipId = await membershipIdOf(business.id, first.id);
      const secondMembershipId = await membershipIdOf(business.id, second.id);
      const adminRoleId = await roleIdFor(app, SeededRoleName.BUSINESS_ADMIN);

      const outcomes = await Promise.allSettled([
        request(app.getHttpServer())
          .patch(
            `/api/businesses/${business.id}/memberships/${firstMembershipId}/role`,
          )
          .set('Authorization', `Bearer ${second.token}`)
          .send({ roleId: adminRoleId }),
        request(app.getHttpServer())
          .patch(
            `/api/businesses/${business.id}/memberships/${secondMembershipId}/role`,
          )
          .set('Authorization', `Bearer ${first.token}`)
          .send({ roleId: adminRoleId }),
      ]);

      const statuses = outcomes.map((outcome) =>
        outcome.status === 'fulfilled' ? outcome.value.status : 0,
      );
      // Exactly one succeeds; the other is refused. The refusal CODE is
      // deliberately not pinned, because two different guards can catch the
      // loser and which one does is genuinely racy:
      //
      //   409 LAST_OWNER_PROTECTED — the loser's own demotion is evaluated
      //       while they are still an owner, and it would empty the business.
      //   403 ROLE_NOT_ASSIGNABLE  — the winner's demotion committed first, so
      //       the loser is now a rank-70 admin trying to act on a rank-100
      //       owner, and the rank ceiling refuses them earlier.
      //
      // Both are correct refusals and both preserve the invariant. Asserting
      // 409 specifically made this pass alone and fail under the parallel
      // suite — the assertion was wrong, not the code.
      expect(statuses.filter((status) => status === 200)).toHaveLength(1);
      expect(
        statuses.filter((status) => status === 403 || status === 409),
      ).toHaveLength(1);
      // What actually matters, asserted on the database.
      expect(await activeOwnerCount(business.id)).toBe(1);
      await assertEveryLiveBusinessHasAUsableOwner();
    });

    it('deletion racing another owner being demoted', async () => {
      const { owner: staying, business } = await seedTenant();
      const leaving = await createRegularUser(app, 'leaving@example.com');
      await addMembership(
        app,
        business.id,
        leaving.id,
        SeededRoleName.BUSINESS_OWNER,
      );
      const stayingMembershipId = await membershipIdOf(business.id, staying.id);
      const adminRoleId = await roleIdFor(app, SeededRoleName.BUSINESS_ADMIN);

      await Promise.allSettled([
        request(app.getHttpServer())
          .delete('/api/users/me')
          .set('Authorization', `Bearer ${leaving.token}`),
        request(app.getHttpServer())
          .patch(
            `/api/businesses/${business.id}/memberships/${stayingMembershipId}/role`,
          )
          .set('Authorization', `Bearer ${leaving.token}`)
          .send({ roleId: adminRoleId }),
      ]);

      await assertEveryLiveBusinessHasAUsableOwner();
    });
  });

  // ── the non-concurrent rules the races depend on ─────────────────────────

  describe('an unusable account can never become an owner', () => {
    it('refuses to add a deleted user to a business at all', async () => {
      const { owner, business } = await seedTenant();
      const admin = await createPlatformAdmin(app);
      const ghost = await createRegularUser(app, 'ghost@example.com');
      const ownerRoleId = await roleIdFor(app, SeededRoleName.BUSINESS_OWNER);

      await request(app.getHttpServer())
        .delete(`/api/users/${ghost.id}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(204);

      await request(app.getHttpServer())
        .post(`/api/businesses/${business.id}/memberships`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ email: ghost.email, roleId: ownerRoleId })
        .expect(404);
    });

    it('refuses to promote a deactivated user to owner', async () => {
      const { owner, business } = await seedTenant();
      const admin = await createPlatformAdmin(app);
      const benched = await createRegularUser(app, 'benched@example.com');
      await addMembership(
        app,
        business.id,
        benched.id,
        SeededRoleName.BUSINESS_ADMIN,
      );
      const benchedMembershipId = await membershipIdOf(business.id, benched.id);
      const ownerRoleId = await roleIdFor(app, SeededRoleName.BUSINESS_OWNER);

      await request(app.getHttpServer())
        .patch(`/api/users/${benched.id}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ isActive: false })
        .expect(200);

      await request(app.getHttpServer())
        .patch(
          `/api/businesses/${business.id}/memberships/${benchedMembershipId}/role`,
        )
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ roleId: ownerRoleId })
        .expect(404);
      await assertEveryLiveBusinessHasAUsableOwner();
    });

    it('refuses to deactivate the sole owner of a live business', async () => {
      const { owner, business } = await seedTenant();
      const admin = await createPlatformAdmin(app);

      // A deactivated owner cannot authenticate, so the business would be as
      // stranded as if the account had been deleted. A platform admin is not
      // exempt: `manage all` bypasses authorization, not data integrity.
      const refused = await request(app.getHttpServer())
        .patch(`/api/users/${owner.id}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ isActive: false })
        .expect(409);
      expect((refused.body as { errorCode?: string }).errorCode).toBe(
        'LAST_OWNER_PROTECTED',
      );

      const unchanged = await prisma.user.findUniqueOrThrow({
        where: { id: owner.id },
        select: { isActive: true },
      });
      expect(unchanged.isActive).toBe(true);
      expect(business.id).toBeDefined();
      await assertEveryLiveBusinessHasAUsableOwner();
    });

    it('GDPR erasure closes the business rather than stranding it', async () => {
      const { owner, business } = await seedTenant();

      // Erasure answers a legal obligation and cannot be refused for a
      // commercial relationship — so the business is closed instead.
      await request(app.getHttpServer())
        .post('/api/users/me/gdpr-erase')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ currentPassword: TEST_PASSWORD })
        .expect(204);

      const closed = await prisma.business.findUniqueOrThrow({
        where: { id: business.id },
        select: { deletedAt: true },
      });
      expect(closed.deletedAt).not.toBeNull();
      await assertEveryLiveBusinessHasAUsableOwner();
    });
  });
});
