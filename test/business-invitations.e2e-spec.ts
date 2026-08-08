import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { BusinessInvitationStatus } from '../src/common/enums/business-invitation-status.enum';
import { BusinessMembershipStatus } from '../src/common/enums/business-membership-status.enum';
import { SeededRoleName } from '../src/common/enums/seeded-role-name.enum';
import { hashOpaqueToken } from '../src/common/util/opaque-token.util';
import { AbilityFactory } from '../src/modules/authorization/ability.factory';
import { PermissionLoaderService } from '../src/modules/authorization/permission-loader.service';
import { BusinessInvitationsService } from '../src/modules/businesses/invitations/business-invitations.service';
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
  TEST_PASSWORD,
} from './setup/rbac';
import { createTestApp } from './setup/test-app';

interface ErrorBody {
  errorCode: string;
}

describe('Business invitations (e2e)', () => {
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

  const invitationsUrl = () => `/api/businesses/${business.id}/invitations`;

  /**
   * Mints an invitation and returns its plaintext token.
   *
   * Goes through the service rather than the HTTP endpoint because the endpoint
   * deliberately does NOT return the token — it is emailed and nowhere else, so
   * that being able to invite an address does not also let you redeem the
   * invitation yourself. The service is the only place the plaintext exists.
   * Every assertion BELOW this helper still goes over HTTP.
   */
  const inviteAndCaptureToken = async (
    email: string,
    roleName: SeededRoleName = SeededRoleName.BUSINESS_MEMBER,
    actorId: string = owner.id,
  ): Promise<{ token: string; invitationId: string }> => {
    const service = app.get(BusinessInvitationsService);
    const ability = await abilityFor(actorId);
    const { invitation, token } = await service.create(
      business.id,
      { email, roleId: await roleIdFor(app, roleName) },
      ability,
      actorId,
    );
    return { token, invitationId: invitation.id };
  };

  // The real compiled ability for a user, so the service sees exactly what a
  // request would hand it — not a hand-built stub that could drift.
  const abilityFor = async (userId: string) => {
    const loader = app.get(PermissionLoaderService);
    const factory = app.get(AbilityFactory);
    return factory.createForUser(userId, await loader.loadGrants(userId));
  };

  const acceptAs = (actor: SeededUser, token: string) =>
    request(app.getHttpServer())
      .post('/api/invitations/accept')
      .set('Authorization', `Bearer ${actor.token}`)
      .send({ token });

  describe('issuing', () => {
    it('an owner may invite an address that has no account yet', async () => {
      await request(app.getHttpServer())
        .post(invitationsUrl())
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          email: 'nobody@example.com',
          roleId: await roleIdFor(app, SeededRoleName.BUSINESS_MEMBER),
        })
        .expect(201);

      // No membership row: there is no user to hang one on. That is the entire
      // reason invitations are a separate model.
      const prisma = app.get(PrismaService);
      expect(
        await prisma.businessMembership.count({
          where: { businessId: business.id },
        }),
      ).toBe(1); // the owner only
    });

    it('never returns the token — it goes to the invited address alone', async () => {
      const response = await request(app.getHttpServer())
        .post(invitationsUrl())
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          email: 'nobody@example.com',
          roleId: await roleIdFor(app, SeededRoleName.BUSINESS_MEMBER),
        })
        .expect(201);

      const body = response.body as Record<string, unknown>;
      expect(body.token).toBeUndefined();
      // The digest must not leak either: SHA-256 over a known 43-character
      // alphabet is not a slow hash, so publishing it invites an offline search.
      expect(body.tokenHash).toBeUndefined();
    });

    it('writes NO membership row when the address already has an account', async () => {
      // The whole point of the rewrite. A placeholder membership consumed the
      // one row `@@unique([businessId, userId])` allows, so an invitation could
      // silently overwrite a former member's history.
      const invitee = await createRegularUser(app, 'invitee@example.com');
      await inviteAndCaptureToken(invitee.email);

      const prisma = app.get(PrismaService);
      expect(
        await prisma.businessMembership.count({
          where: { businessId: business.id, userId: invitee.id },
        }),
      ).toBe(0);
    });

    it('records the invitee\u2019s account id on the invitation', async () => {
      // Resolved ONCE, at invite time. Revoke and accept used to re-derive
      // identity from the address, so a re-registered address inherited
      // somebody else's invitation.
      const invitee = await createRegularUser(app, 'invitee@example.com');
      await inviteAndCaptureToken(invitee.email);

      const invitation = await app
        .get(PrismaService)
        .businessInvitation.findFirstOrThrow({
          where: { businessId: business.id, email: invitee.email },
        });
      expect(invitation.invitedUserId).toBe(invitee.id);
    });

    it('leaves invitedUserId null when the address has no account', async () => {
      await inviteAndCaptureToken('stranger@example.com');

      const invitation = await app
        .get(PrismaService)
        .businessInvitation.findFirstOrThrow({
          where: { businessId: business.id, email: 'stranger@example.com' },
        });
      expect(invitation.invitedUserId).toBeNull();
    });

    it('an outstanding invitation grants nothing', async () => {
      const invitee = await createRegularUser(app, 'invitee@example.com');
      await inviteAndCaptureToken(invitee.email, SeededRoleName.BUSINESS_ADMIN);

      await request(app.getHttpServer())
        .get(`/api/businesses/${business.id}`)
        .set('Authorization', `Bearer ${invitee.token}`)
        .expect(404);
    });

    it('refuses to invite someone already on the roster', async () => {
      const member = await createRegularUser(app, 'member@example.com');
      await addMembership(
        app,
        business.id,
        member.id,
        SeededRoleName.BUSINESS_MEMBER,
      );

      await request(app.getHttpServer())
        .post(invitationsUrl())
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          email: member.email,
          roleId: await roleIdFor(app, SeededRoleName.BUSINESS_MEMBER),
        })
        .expect(409);
    });

    it('refuses a second pending invitation to the same address', async () => {
      const prisma = app.get(PrismaService);
      await inviteAndCaptureToken('invitee@example.com');

      const response = await request(app.getHttpServer())
        .post(invitationsUrl())
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          email: 'invitee@example.com',
          roleId: await roleIdFor(app, SeededRoleName.BUSINESS_MEMBER),
        })
        .expect(409);

      expect((response.body as ErrorBody).errorCode).toBe('RESOURCE_CONFLICT');

      // The live invitation must survive untouched. `create` retires lapsed
      // rows before inserting; if that retirement ever loses its `expiresAt`
      // scope, this row would be flipped to EXPIRED and the 409 above would
      // still pass — so the status assertion, not the status code, is what
      // pins the rule.
      const invitations = await prisma.businessInvitation.findMany({
        where: { businessId: business.id, email: 'invitee@example.com' },
        select: { status: true },
      });
      expect(invitations).toHaveLength(1);
      expect(invitations[0].status as BusinessInvitationStatus).toBe(
        BusinessInvitationStatus.PENDING,
      );
    });

    it('allows re-inviting an address whose earlier invitation EXPIRED', async () => {
      // Regression. Expiry is a timestamp, not a status, so an unattended
      // invitation stays `pending` for ever — and the partial unique index on
      // `(business_id, email) WHERE status = 'pending'` counted that dead row as
      // an outstanding invitation. The second POST failed with 409 forever, and
      // the message claimed a pending invitation existed when the only one had
      // expired weeks earlier. `create` now retires expired rows under the
      // business lock it already holds.
      const prisma = app.get(PrismaService);
      await inviteAndCaptureToken('invitee@example.com');

      await prisma.businessInvitation.updateMany({
        where: { businessId: business.id, email: 'invitee@example.com' },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      await request(app.getHttpServer())
        .post(invitationsUrl())
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          email: 'invitee@example.com',
          roleId: await roleIdFor(app, SeededRoleName.BUSINESS_MEMBER),
        })
        .expect(201);

      const invitations = await prisma.businessInvitation.findMany({
        where: { businessId: business.id, email: 'invitee@example.com' },
        select: { status: true },
      });
      // `status` is a String column constrained by the TS enum, so cast at the
      // DB boundary before comparing (see CLAUDE.md, TypeScript gotchas).
      const statuses = invitations.map(
        (invitation) => invitation.status as BusinessInvitationStatus,
      );
      // Two rows: the retired one and the live one. Exactly one may be pending,
      // which is the property the partial unique index actually protects.
      expect(statuses).toHaveLength(2);
      expect(
        statuses.filter(
          (status) => status === BusinessInvitationStatus.PENDING,
        ),
      ).toHaveLength(1);
      expect(
        statuses.filter(
          (status) => status === BusinessInvitationStatus.EXPIRED,
        ),
      ).toHaveLength(1);
    });

    it('retires only the expired invitation for this business AND this address', async () => {
      // The retirement is a write over `business_invitations` scoped by
      // `businessId` AND `email`. Both halves need a witness or they are
      // untested: dropping `businessId` turns one tenant's invite into a
      // cross-tenant write, and dropping `email` retires every lapsed
      // invitation in the business. Neither is observable without a second
      // business and a second address, so this test seeds both.
      const prisma = app.get(PrismaService);
      const otherOwner = await createRegularUser(app, 'other@example.com');
      const otherBusiness = await createBusinessWithOwner(
        app,
        otherOwner.id,
        'other-business',
      );

      await inviteAndCaptureToken('shared@example.com');
      // Same business, DIFFERENT address — the witness for the `email` half.
      await inviteAndCaptureToken('bystander@example.com');
      await request(app.getHttpServer())
        .post(`/api/businesses/${otherBusiness.id}/invitations`)
        .set('Authorization', `Bearer ${otherOwner.token}`)
        .send({
          email: 'shared@example.com',
          roleId: await roleIdFor(app, SeededRoleName.BUSINESS_MEMBER),
        })
        .expect(201);

      // Every invitation in play is now lapsed, so only the scoping of the
      // retirement decides which ones get retired.
      await prisma.businessInvitation.updateMany({
        where: {},
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      // Re-inviting in OUR business must retire ours and leave theirs alone.
      await request(app.getHttpServer())
        .post(invitationsUrl())
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          email: 'shared@example.com',
          roleId: await roleIdFor(app, SeededRoleName.BUSINESS_MEMBER),
        })
        .expect(201);

      // The other business's invitation is untouched — pins the `businessId` half.
      const theirInvitations = await prisma.businessInvitation.findMany({
        where: { businessId: otherBusiness.id, email: 'shared@example.com' },
        select: { status: true },
      });
      expect(theirInvitations).toHaveLength(1);
      expect(theirInvitations[0].status as BusinessInvitationStatus).toBe(
        BusinessInvitationStatus.PENDING,
      );

      // Our own other address is untouched — pins the `email` half. Without
      // this, deleting `email` from the retirement's `where` passes the suite.
      const bystanderInvitations = await prisma.businessInvitation.findMany({
        where: { businessId: business.id, email: 'bystander@example.com' },
        select: { status: true },
      });
      expect(bystanderInvitations).toHaveLength(1);
      expect(bystanderInvitations[0].status as BusinessInvitationStatus).toBe(
        BusinessInvitationStatus.PENDING,
      );
    });

    it('enforces the rank ceiling at INVITE time, not just at acceptance', async () => {
      // Checking only on acceptance would be too late in the way that matters:
      // the email would already have promised a role the inviter could never
      // grant, and the refusal would land on the invitee.
      const businessAdmin = await createRegularUser(app, 'ba@example.com');
      await addMembership(
        app,
        business.id,
        businessAdmin.id,
        SeededRoleName.BUSINESS_ADMIN,
      );

      const response = await request(app.getHttpServer())
        .post(invitationsUrl())
        .set('Authorization', `Bearer ${businessAdmin.token}`)
        .send({
          email: 'invitee@example.com',
          roleId: await roleIdFor(app, SeededRoleName.BUSINESS_OWNER),
        })
        .expect(403);

      expect((response.body as ErrorBody).errorCode).toBe(
        'ROLE_NOT_ASSIGNABLE',
      );
    });

    it('refuses a PLATFORM-scoped role', async () => {
      const response = await request(app.getHttpServer())
        .post(invitationsUrl())
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          email: 'invitee@example.com',
          roleId: await roleIdFor(app, SeededRoleName.PLATFORM_ADMIN),
        })
        .expect(403);

      expect((response.body as ErrorBody).errorCode).toBe(
        'ROLE_NOT_ASSIGNABLE',
      );
    });

    it('a platform role smuggled onto an invitation grants NOTHING once accepted', async () => {
      // An invitation names the role its acceptor receives, so it is a second
      // door into the same escalation as a membership. The service refuses it
      // with a 403 (above); this asserts the end state if some future code path
      // writes the row directly, and follows it all the way through acceptance
      // rather than stopping at the insert.
      const prisma = app.get(PrismaService);
      const invitee = await createRegularUser(app, 'invitee@example.com');
      const token = 'z'.repeat(43);
      await prisma.businessInvitation.create({
        data: {
          businessId: business.id,
          email: invitee.email,
          roleId: await roleIdFor(app, SeededRoleName.PLATFORM_ADMIN),
          tokenHash: hashOpaqueToken(token),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });

      // Acceptance succeeds — nothing structurally forbids the row.
      await acceptAs(invitee, token).expect(200);

      // …and the resulting membership confers nothing, because `AbilityFactory`
      // drops a PLATFORM permission arriving through a membership.
      await request(app.getHttpServer())
        .get('/api/users')
        .set('Authorization', `Bearer ${invitee.token}`)
        .expect(403);
      await request(app.getHttpServer())
        .get(`/api/businesses/${business.id}`)
        .set('Authorization', `Bearer ${invitee.token}`)
        .expect(404);
    });

    it('a member with no invite permission cannot invite', async () => {
      const member = await createRegularUser(app, 'member@example.com');
      await addMembership(
        app,
        business.id,
        member.id,
        SeededRoleName.BUSINESS_MEMBER,
      );

      await request(app.getHttpServer())
        .post(invitationsUrl())
        .set('Authorization', `Bearer ${member.token}`)
        .send({
          email: 'invitee@example.com',
          roleId: await roleIdFor(app, SeededRoleName.BUSINESS_MEMBER),
        })
        .expect(403);
    });
  });

  describe('acceptance', () => {
    it('an existing user accepts and becomes ACTIVE', async () => {
      const invitee = await createRegularUser(app, 'invitee@example.com');
      const { token } = await inviteAndCaptureToken(invitee.email);

      await acceptAs(invitee, token).expect(200);

      const prisma = app.get(PrismaService);
      const membership = await prisma.businessMembership.findUniqueOrThrow({
        where: {
          businessId_userId: { businessId: business.id, userId: invitee.id },
        },
      });
      expect(membership.status).toBe(BusinessMembershipStatus.ACTIVE);
      expect(membership.joinedAt).not.toBeNull();

      // Authority follows immediately — the grants cache was invalidated.
      await request(app.getHttpServer())
        .get(`/api/businesses/${business.id}`)
        .set('Authorization', `Bearer ${invitee.token}`)
        .expect(200);
    });

    it('someone who registers AFTER being invited can still accept', async () => {
      // The token stays valid across registration, which is what lets the
      // platform keep ONE registration policy instead of forking a second
      // account-creation path behind a bearer token.
      const { token } = await inviteAndCaptureToken('newcomer@example.com');

      await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          email: 'newcomer@example.com',
          password: TEST_PASSWORD,
          firstName: 'New',
          lastName: 'Comer',
        })
        .expect(201);

      const prisma = app.get(PrismaService);
      const created = await prisma.user.findFirstOrThrow({
        where: { email: 'newcomer@example.com' },
      });
      await prisma.user.update({
        where: { id: created.id },
        data: { emailVerifiedAt: new Date() },
      });
      const newcomer = await createSessionFor('newcomer@example.com');

      await acceptAs(newcomer, token).expect(200);

      const membership = await prisma.businessMembership.findUniqueOrThrow({
        where: {
          businessId_userId: { businessId: business.id, userId: created.id },
        },
      });
      expect(membership.status).toBe(BusinessMembershipStatus.ACTIVE);
    });

    it('a DIFFERENT account cannot redeem a forwarded invitation', async () => {
      // Without the email match the token alone would be sufficient, and a
      // forwarded invitation would let anyone join a business that invited
      // somebody else specifically.
      const invitee = await createRegularUser(app, 'invitee@example.com');
      void invitee;
      const bystander = await createRegularUser(app, 'bystander@example.com');
      const { token } = await inviteAndCaptureToken('invitee@example.com');

      const response = await acceptAs(bystander, token).expect(400);
      expect((response.body as ErrorBody).errorCode).toBe('INVITATION_INVALID');
    });

    it('rejects an unknown token indistinguishably from a used one', async () => {
      const invitee = await createRegularUser(app, 'invitee@example.com');
      const response = await acceptAs(invitee, 'z'.repeat(43)).expect(400);
      expect((response.body as ErrorBody).errorCode).toBe('INVITATION_INVALID');
    });

    it('rejects an EXPIRED invitation, distinguishably', async () => {
      // Safe to distinguish: the holder already proved possession of a real
      // token, so this discloses nothing they did not have — and their remedy
      // differs from "that link is wrong".
      const invitee = await createRegularUser(app, 'invitee@example.com');
      const { token, invitationId } = await inviteAndCaptureToken(
        invitee.email,
      );

      const prisma = app.get(PrismaService);
      await prisma.businessInvitation.update({
        where: { id: invitationId },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      const response = await acceptAs(invitee, token).expect(400);
      expect((response.body as ErrorBody).errorCode).toBe('INVITATION_EXPIRED');
    });

    it('still reports EXPIRED after the row was retired by a re-invitation', async () => {
      // Regression. `create` retires lapsed rows to EXPIRED to free the pending
      // partial index. `accept` checks `status !== PENDING` BEFORE it checks
      // `expiresAt`, so without an explicit carve-out the retirement silently
      // downgraded this answer from INVITATION_EXPIRED to INVITATION_INVALID —
      // the least actionable message, delivered at the exact moment a fresh
      // invitation was sitting in the recipient's inbox, and varying by whether
      // some unrelated actor happened to re-invite.
      const invitee = await createRegularUser(app, 'invitee@example.com');
      const { token, invitationId } = await inviteAndCaptureToken(
        invitee.email,
      );

      const prisma = app.get(PrismaService);
      await prisma.businessInvitation.update({
        where: { id: invitationId },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      // Re-invite the same address — this retires the row above to EXPIRED.
      await request(app.getHttpServer())
        .post(invitationsUrl())
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          email: invitee.email,
          roleId: await roleIdFor(app, SeededRoleName.BUSINESS_MEMBER),
        })
        .expect(201);

      const retired = await prisma.businessInvitation.findUniqueOrThrow({
        where: { id: invitationId },
        select: { status: true },
      });
      expect(retired.status as BusinessInvitationStatus).toBe(
        BusinessInvitationStatus.EXPIRED,
      );

      const response = await acceptAs(invitee, token).expect(400);
      expect((response.body as ErrorBody).errorCode).toBe('INVITATION_EXPIRED');
    });

    it('rejects a REVOKED invitation', async () => {
      const invitee = await createRegularUser(app, 'invitee@example.com');
      const { token, invitationId } = await inviteAndCaptureToken(
        invitee.email,
      );

      await request(app.getHttpServer())
        .delete(`${invitationsUrl()}/${invitationId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(204);

      const response = await acceptAs(invitee, token).expect(400);
      expect((response.body as ErrorBody).errorCode).toBe('INVITATION_INVALID');

      // Revoking also clears the placeholder membership it reserved.
      const prisma = app.get(PrismaService);
      expect(
        await prisma.businessMembership.count({
          where: { businessId: business.id, userId: invitee.id },
        }),
      ).toBe(0);
    });

    it('rejects a REPLAYED invitation — acceptance is single-use', async () => {
      const invitee = await createRegularUser(app, 'invitee@example.com');
      const { token } = await inviteAndCaptureToken(invitee.email);

      await acceptAs(invitee, token).expect(200);
      const replay = await acceptAs(invitee, token).expect(400);
      expect((replay.body as ErrorBody).errorCode).toBe('INVITATION_INVALID');
    });

    it('refuses an invitation to a soft-deleted business', async () => {
      const invitee = await createRegularUser(app, 'invitee@example.com');
      const { token } = await inviteAndCaptureToken(invitee.email);

      await request(app.getHttpServer())
        .delete(`/api/businesses/${business.id}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(204);

      const response = await acceptAs(invitee, token).expect(400);
      expect((response.body as ErrorBody).errorCode).toBe('INVITATION_INVALID');
    });

    it('CONCURRENT acceptance of one token produces exactly ONE membership', async () => {
      // The invariant the conditional consume exists for. Both requests attempt
      // the same UPDATE out of `pending`; exactly one matches a row, and the
      // loser's whole transaction — membership included — rolls back.
      const invitee = await createRegularUser(app, 'invitee@example.com');
      const { token } = await inviteAndCaptureToken(invitee.email);

      const results = await Promise.all([
        acceptAs(invitee, token),
        acceptAs(invitee, token),
      ]);

      const statuses = results.map((response) => response.status).sort();
      expect(statuses).toEqual([200, 400]);

      // Read from the database, not from the status codes: a race that produced
      // two rows could still return one 200 and one 400 by luck.
      const prisma = app.get(PrismaService);
      expect(
        await prisma.businessMembership.count({
          where: { businessId: business.id, userId: invitee.id },
        }),
      ).toBe(1);

      const invitations = await prisma.businessInvitation.findMany({
        where: { businessId: business.id },
      });
      expect(invitations).toHaveLength(1);
      expect(invitations[0].status).toBe(BusinessInvitationStatus.ACCEPTED);
      expect(invitations[0].acceptedBy).toBe(invitee.id);
    });

    it('someone who LEFT can be re-invited, reusing the same row', async () => {
      const invitee = await createRegularUser(app, 'invitee@example.com');
      await addMembership(
        app,
        business.id,
        invitee.id,
        SeededRoleName.BUSINESS_MEMBER,
        BusinessMembershipStatus.LEFT,
      );

      const { token } = await inviteAndCaptureToken(invitee.email);
      await acceptAs(invitee, token).expect(200);

      const prisma = app.get(PrismaService);
      const rows = await prisma.businessMembership.findMany({
        where: { businessId: business.id, userId: invitee.id },
      });
      // `@@unique([businessId, userId])` is unconditional — there can only ever
      // be one.
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe(BusinessMembershipStatus.ACTIVE);
      expect(rows[0].endedAt).toBeNull();
    });

    it('requires authentication — there is no anonymous redemption', async () => {
      await request(app.getHttpServer())
        .post('/api/invitations/accept')
        .send({ token: 'z'.repeat(43) })
        .expect(401);
    });
  });

  describe('listing and revocation', () => {
    it('a stranger to the business sees no invitations', async () => {
      await inviteAndCaptureToken('invitee@example.com');
      const stranger = await createRegularUser(app, 'stranger@example.com');

      const response = await request(app.getHttpServer())
        .get(invitationsUrl())
        .set('Authorization', `Bearer ${stranger.token}`)
        .expect(200);

      expect((response.body as { data: unknown[] }).data).toEqual([]);
    });

    it('an accepted invitation cannot be revoked', async () => {
      const invitee = await createRegularUser(app, 'invitee@example.com');
      const { token, invitationId } = await inviteAndCaptureToken(
        invitee.email,
      );
      await acceptAs(invitee, token).expect(200);

      await request(app.getHttpServer())
        .delete(`${invitationsUrl()}/${invitationId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(409);
    });
  });

  describe('resending', () => {
    it('rotates the token, killing the previous one', async () => {
      // The security-relevant half. Re-mailing the SAME secret would leave every
      // earlier copy live in every inbox and mail log it passed through; after a
      // resend exactly one token opens this invitation.
      const invitee = await createRegularUser(app, 'invitee@example.com');
      const { token: originalToken, invitationId } =
        await inviteAndCaptureToken(invitee.email);
      const before = await app
        .get(PrismaService)
        .businessInvitation.findUniqueOrThrow({ where: { id: invitationId } });

      await request(app.getHttpServer())
        .post(`${invitationsUrl()}/${invitationId}/resend`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      const after = await app
        .get(PrismaService)
        .businessInvitation.findUniqueOrThrow({ where: { id: invitationId } });
      expect(after.tokenHash).not.toBe(before.tokenHash);
      expect(after.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before.expiresAt.getTime(),
      );
      expect(after.status).toBe(BusinessInvitationStatus.PENDING);

      // The old token is dead, and says so in the same way an unknown token
      // does — INVITATION_INVALID, never a distinguishable "that token was
      // rotated".
      const rejected = await acceptAs(invitee, originalToken).expect(400);
      expect((rejected.body as ErrorBody).errorCode).toBe('INVITATION_INVALID');
    });

    it('the rotated token works', async () => {
      const invitee = await createRegularUser(app, 'invitee@example.com');
      const { invitationId } = await inviteAndCaptureToken(invitee.email);

      await request(app.getHttpServer())
        .post(`${invitationsUrl()}/${invitationId}/resend`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      // Captured the same way `inviteAndCaptureToken` does — by planting a
      // known hash, since the plaintext is emailed and never returned.
      const replacementToken = 'replacement-token-for-this-spec';
      await app.get(PrismaService).businessInvitation.update({
        where: { id: invitationId },
        data: { tokenHash: hashOpaqueToken(replacementToken) },
      });

      await acceptAs(invitee, replacementToken).expect(200);
    });

    it('a consumed invitation cannot be resent', async () => {
      const invitee = await createRegularUser(app, 'invitee@example.com');
      const { token, invitationId } = await inviteAndCaptureToken(
        invitee.email,
      );
      await acceptAs(invitee, token).expect(200);

      await request(app.getHttpServer())
        .post(`${invitationsUrl()}/${invitationId}/resend`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(409);
    });

    it('a stranger to the business gets a 404, not a 403', async () => {
      // A 403 would confirm that this invitation exists in this business.
      const { invitationId } = await inviteAndCaptureToken(
        'invitee@example.com',
      );
      const stranger = await createRegularUser(app, 'stranger@example.com');

      await request(app.getHttpServer())
        .post(`${invitationsUrl()}/${invitationId}/resend`)
        .set('Authorization', `Bearer ${stranger.token}`)
        .expect(403);
    });
  });

  describe('who may redeem an invitation', () => {
    it('refuses a caller who is not the invited ACCOUNT', async () => {
      // `invitedUserId` was resolved at invite time, so identity is the account
      // id — not the address, which either party may have changed since.
      const invitee = await createRegularUser(app, 'invitee@example.com');
      const bystander = await createRegularUser(app, 'bystander@example.com');
      const { token } = await inviteAndCaptureToken(invitee.email);

      const rejected = await acceptAs(bystander, token).expect(400);
      expect((rejected.body as ErrorBody).errorCode).toBe('INVITATION_INVALID');
    });

    it('refuses a re-registered address that inherited the invitation', async () => {
      // Invite an address with no account, then have somebody register it. The
      // address alone is not identity; control of it must be proven.
      const { token } = await inviteAndCaptureToken('ghost@example.com');
      const prisma = app.get(PrismaService);
      const squatter = await createRegularUser(app, 'squatter@example.com');
      // Unverified: exactly the state an email CHANGE leaves an account in,
      // while the access token issued beforehand keeps working.
      await prisma.user.update({
        where: { id: squatter.id },
        data: { email: 'ghost@example.com', emailVerifiedAt: null },
      });

      const rejected = await request(app.getHttpServer())
        .post('/api/invitations/accept')
        .set('Authorization', `Bearer ${squatter.token}`)
        .send({ token })
        .expect(400);
      expect((rejected.body as ErrorBody).errorCode).toBe('INVITATION_INVALID');

      expect(
        await prisma.businessMembership.count({
          where: { businessId: business.id, userId: squatter.id },
        }),
      ).toBe(0);
    });

    it('admits a stranger who registered the address and verified it', async () => {
      const { token } = await inviteAndCaptureToken('newcomer@example.com');
      const newcomer = await createRegularUser(app, 'newcomer@example.com');

      await acceptAs(newcomer, token).expect(200);
    });
  });

  // Logs a seeded user in again after their row was created out-of-band.
  const createSessionFor = async (email: string): Promise<SeededUser> => {
    const prisma = app.get(PrismaService);
    const user = await prisma.user.findFirstOrThrow({ where: { email } });
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ identifier: email, password: TEST_PASSWORD })
      .expect(200);
    return {
      id: user.id,
      email,
      token: (response.body as { accessToken: string }).accessToken,
    };
  };
});
