import { INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { truncateAll } from './setup/db';
import {
  createPlatformAdmin,
  seedRbacCatalog,
  TEST_PASSWORD,
} from './setup/rbac';
import { createTestApp } from './setup/test-app';

const NEW_PASSWORD = 'brand-new-passphrase-9';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * The credential-change contract.
 *
 * Changing a password is the one remediation every user knows: "I think someone
 * has my account, I'll change my password." It is only worth anything if it
 * actually ends the attacker's session — on every device, through every route
 * that can change a credential.
 *
 * Access-token expiry alone is not that. A stolen refresh token re-extends its
 * own expiry on every exchange, so a session that survives a password change
 * survives indefinitely, while the victim believes they have closed it.
 */
describe('Credential change revokes every session (e2e)', () => {
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

  const registerVerified = async (email: string): Promise<string> => {
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({
        email,
        password: TEST_PASSWORD,
        firstName: 'Credential',
        lastName: 'Tester',
      })
      .expect(201);
    const prisma = app.get(PrismaService);
    const user = await prisma.user.findFirstOrThrow({ where: { email } });
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date() },
    });
    return user.id;
  };

  const login = async (
    email: string,
    password = TEST_PASSWORD,
  ): Promise<TokenPair> => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ identifier: email, password })
      .expect(200);
    return response.body as TokenPair;
  };

  const refresh = (refreshToken: string) =>
    request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken });

  const liveTokenCount = async (userId: string): Promise<number> =>
    app
      .get(PrismaService)
      .refreshToken.count({ where: { userId, revokedAt: null } });

  describe('every password-change route applies the same policy', () => {
    it('self-service: PATCH /users/me/password', async () => {
      const userId = await registerVerified('self@example.com');
      // Two devices, so "all devices" is a real assertion rather than a
      // restatement of "the one session".
      const phone = await login('self@example.com');
      const laptop = await login('self@example.com');

      await request(app.getHttpServer())
        .patch('/api/users/me/password')
        .set('Authorization', `Bearer ${laptop.accessToken}`)
        .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })
        .expect(200);

      // Old access token — rejected by the `passwordChangedAt` vs `iat` check.
      //
      // This assertion was intermittently green until the cutoff was rounded up
      // on write (`nextWholeSecond`): `iat` is whole seconds, so a token issued
      // in the SAME second as the password change floored to the same value and
      // survived. A test that passes only when the two land in different seconds
      // is a test that hides a one-second authentication hole — and with a
      // 30-day access token, that hole is 30 days of access.
      await request(app.getHttpServer())
        .get('/api/users/me')
        .set('Authorization', `Bearer ${phone.accessToken}`)
        .expect(401);

      // Old refresh tokens — BOTH devices, not just the one that acted.
      await refresh(phone.refreshToken).expect(401);
      await refresh(laptop.refreshToken).expect(401);

      // Asserted on rows, not status codes: a 401 could come from some other
      // path, but a live row is unambiguous.
      expect(await liveTokenCount(userId)).toBe(0);
    });

    it('OTP reset: POST /users/reset-password', async () => {
      const userId = await registerVerified('otp@example.com');
      const session = await login('otp@example.com');

      await request(app.getHttpServer())
        .post('/api/users/request-password-reset')
        .send({ email: 'otp@example.com' })
        .expect(200);

      // The OTP is hashed at rest, so the test plants a known one rather than
      // scraping it out of a log line.
      const prisma = app.get(PrismaService);
      await prisma.user.update({
        where: { id: userId },
        data: { otpHash: await bcrypt.hash('123456', 10) },
      });

      await request(app.getHttpServer())
        .post('/api/users/reset-password')
        .send({
          email: 'otp@example.com',
          otp: '123456',
          newPassword: NEW_PASSWORD,
        })
        .expect(200);

      await refresh(session.refreshToken).expect(401);
      expect(await liveTokenCount(userId)).toBe(0);
    });

    it('administrative reset: PATCH /users/:id/password', async () => {
      const admin = await createPlatformAdmin(app);
      const userId = await registerVerified('victim@example.com');
      const session = await login('victim@example.com');

      await request(app.getHttpServer())
        .patch(`/api/users/${userId}/password`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ newPassword: NEW_PASSWORD })
        .expect(200);

      await refresh(session.refreshToken).expect(401);
      expect(await liveTokenCount(userId)).toBe(0);
    });
  });

  describe('the generic admin update cannot change a password', () => {
    it('rejects a password field on PATCH /users/:id', async () => {
      // `update User` and `resetPassword User` are separate permissions on
      // purpose. Letting the profile-edit route write a credential collapsed
      // that boundary and skipped the current-password re-auth.
      const admin = await createPlatformAdmin(app);
      const userId = await registerVerified('target@example.com');

      const response = await request(app.getHttpServer())
        .patch(`/api/users/${userId}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ firstName: 'Renamed', password: NEW_PASSWORD })
        .expect(400);

      expect((response.body as { errorCode: string }).errorCode).toBe(
        'VALIDATION_FAILED',
      );

      // And the old credential still works — nothing was written.
      await login('target@example.com');
    });
  });

  describe('concurrency', () => {
    it('a refresh racing a password change leaves NO live token', async () => {
      // The race the user-level lock exists for. Without it, a rotation that
      // had inserted its replacement but not committed sat outside the
      // revoking statement's snapshot and survived — so the password change
      // reported success while one renewable token lived on.
      const userId = await registerVerified('race@example.com');
      const session = await login('race@example.com');
      const actor = await login('race@example.com');

      await Promise.all([
        refresh(session.refreshToken),
        request(app.getHttpServer())
          .patch('/api/users/me/password')
          .set('Authorization', `Bearer ${actor.accessToken}`)
          .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }),
      ]);

      expect(await liveTokenCount(userId)).toBe(0);
    });

    it('a refresh racing logout-all leaves NO live token', async () => {
      const userId = await registerVerified('logoutall@example.com');
      const session = await login('logoutall@example.com');
      const actor = await login('logoutall@example.com');

      await Promise.all([
        refresh(session.refreshToken),
        request(app.getHttpServer())
          .post('/api/auth/logout-all')
          .set('Authorization', `Bearer ${actor.accessToken}`),
      ]);

      expect(await liveTokenCount(userId)).toBe(0);
    });

    it('a refresh racing support revocation leaves NO live token', async () => {
      const support = await createPlatformAdmin(app, 'support@example.com');
      const userId = await registerVerified('supported@example.com');
      const session = await login('supported@example.com');

      await Promise.all([
        refresh(session.refreshToken),
        request(app.getHttpServer())
          .post(`/api/users/${userId}/revoke-sessions`)
          .set('Authorization', `Bearer ${support.token}`),
      ]);

      expect(await liveTokenCount(userId)).toBe(0);
    });
  });

  describe('defence in depth', () => {
    it('rejects a refresh token predating passwordChangedAt even if it was missed', async () => {
      // Simulates a future code path that writes a password without going
      // through `applyPasswordChange`: the row is left live on purpose, and
      // `rotate` must still refuse it on the timestamp alone.
      const userId = await registerVerified('backstop@example.com');
      const session = await login('backstop@example.com');

      const prisma = app.get(PrismaService);
      await prisma.user.update({
        where: { id: userId },
        data: { passwordChangedAt: new Date(Date.now() + 1_000) },
      });

      await refresh(session.refreshToken).expect(401);
    });
  });

  it('support session revocation does not touch the password', async () => {
    // Revoking sessions is an incident-response action, not a credential
    // change: the account holder keeps their password.
    const support = await createPlatformAdmin(app, 'ops@example.com');
    const userId = await registerVerified('kept@example.com');
    void userId;
    const session = await login('kept@example.com');

    await request(app.getHttpServer())
      .post(
        `/api/users/${(await app.get(PrismaService).user.findFirstOrThrow({ where: { email: 'kept@example.com' } })).id}/revoke-sessions`,
      )
      .set('Authorization', `Bearer ${support.token}`)
      .expect(204);

    await refresh(session.refreshToken).expect(401);
    // …and the original credential still authenticates.
    await login('kept@example.com');
  });

  it('a platform admin is not exempt from any of this', async () => {
    const admin = await createPlatformAdmin(app);
    const session = await login(admin.email);

    await request(app.getHttpServer())
      .patch('/api/users/me/password')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })
      .expect(200);

    expect(await liveTokenCount(admin.id)).toBe(0);
  });
});
