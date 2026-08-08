import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { hashOpaqueToken } from '../src/common/util/opaque-token.util';
import { RefreshTokenService } from '../src/modules/auth/refresh-token.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { pauseBefore, runRace } from './setup/barrier';
import { truncateAll } from './setup/db';
import {
  createPlatformAdmin,
  createRegularUser,
  seedRbacCatalog,
  TEST_PASSWORD,
} from './setup/rbac';
import { createTestApp } from './setup/test-app';

const NEW_PASSWORD = 'a-completely-different-passphrase-4';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * Session issuance is serialized against every revocation.
 *
 * The invariant, stated once: **when a security operation revokes all sessions
 * for a user, no session operation that began before or raced with it may leave
 * a usable access or refresh token afterwards.**
 *
 * The gap this file was written for is the window between "the password
 * verified" and "the tokens exist". bcrypt takes ~250ms and must not run inside
 * a transaction, so that window is real and wide. A login that started before a
 * logout-all used to finish after it — inserting a refresh row the revocation's
 * `updateMany` had already scanned past, and minting an access token with an
 * `iat` NEWER than the cutoff the revocation wrote. Both survived. With a 30-day
 * access token, "sign me out everywhere" left a month of access behind.
 *
 * Every race here is driven through `test/setup/barrier.ts`, not `Promise.all`:
 * the login is parked at the exact seam where its lock would be taken, the
 * revocation runs to completion, and only then is the login released. There is
 * no interleaving for the scheduler to choose.
 *
 * Assertions are on DATABASE STATE and on whether the tokens actually work —
 * never on the status code alone, which cannot tell a revoked token from a live
 * one.
 */
describe('Session issuance races (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let refreshTokenService: RefreshTokenService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    refreshTokenService = app.get(RefreshTokenService);
  });

  beforeEach(async () => {
    await truncateAll(app);
    await seedRbacCatalog(app);
  });

  afterAll(async () => {
    await app.close();
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  const login = (email: string, password = TEST_PASSWORD) =>
    request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ identifier: email, password });

  const loginPair = async (
    email: string,
    password = TEST_PASSWORD,
  ): Promise<TokenPair> => {
    const response = await login(email, password).expect(200);
    return response.body as TokenPair;
  };

  /** Does this access token still open an authenticated route? */
  const accessTokenWorks = async (accessToken: string): Promise<boolean> => {
    const response = await request(app.getHttpServer())
      .get('/api/users/me')
      .set('Authorization', `Bearer ${accessToken}`);
    return response.status === 200;
  };

  /** Does this refresh token still mint a new pair? */
  const refreshTokenWorks = async (refreshToken: string): Promise<boolean> => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken });
    return response.status === 200;
  };

  const liveRefreshRowCount = (userId: string) =>
    prisma.refreshToken.count({ where: { userId, revokedAt: null } });

  /**
   * The seam: `issueForNewSession` is the first thing a login does that takes a
   * lock, and everything the login decided — including the password compare —
   * happened before it.
   */
  const pauseIssuance = () =>
    pauseBefore(refreshTokenService, 'issueForNewSession');

  // ── login racing each revocation path ────────────────────────────────────

  describe('login racing a revocation', () => {
    it('is refused when logout-all commits first, leaving nothing usable', async () => {
      const user = await createRegularUser(app, 'racer@example.com');
      const firstDevice = await loginPair(user.email);

      const paused = pauseIssuance();
      const outcome = await runRace(login(user.email), paused, () =>
        request(app.getHttpServer())
          .post('/api/auth/logout-all')
          .set('Authorization', `Bearer ${firstDevice.accessToken}`)
          .expect(204),
      );

      // The login is refused with the ordinary opaque credential error — it
      // must not disclose which concurrent security event beat it.
      expect(outcome.paused.status).toBe('fulfilled');
      const loginResponse =
        outcome.paused.status === 'fulfilled' ? outcome.paused.value : null;
      expect(loginResponse?.status).toBe(401);
      expect((loginResponse?.body as { errorCode?: string })?.errorCode).toBe(
        'INVALID_CREDENTIALS',
      );

      // Database state, not the status code: no refresh row survived at all.
      expect(await liveRefreshRowCount(user.id)).toBe(0);
      expect(await refreshTokenWorks(firstDevice.refreshToken)).toBe(false);
      expect(await accessTokenWorks(firstDevice.accessToken)).toBe(false);
    });

    it('is refused when a password change commits first', async () => {
      const user = await createRegularUser(app, 'racer@example.com');
      const device = await loginPair(user.email);

      const paused = pauseIssuance();
      const outcome = await runRace(login(user.email), paused, () =>
        request(app.getHttpServer())
          .patch('/api/users/me/password')
          .set('Authorization', `Bearer ${device.accessToken}`)
          .send({
            currentPassword: TEST_PASSWORD,
            newPassword: NEW_PASSWORD,
          })
          .expect(200),
      );

      const loginResponse =
        outcome.paused.status === 'fulfilled' ? outcome.paused.value : null;
      expect(loginResponse?.status).toBe(401);
      expect(await liveRefreshRowCount(user.id)).toBe(0);
    });

    it('is refused when support revokes the account first', async () => {
      const admin = await createPlatformAdmin(app);
      const user = await createRegularUser(app, 'racer@example.com');
      await loginPair(user.email);

      const paused = pauseIssuance();
      const outcome = await runRace(login(user.email), paused, () =>
        request(app.getHttpServer())
          .post(`/api/users/${user.id}/revoke-sessions`)
          .set('Authorization', `Bearer ${admin.token}`)
          .expect(204),
      );

      const loginResponse =
        outcome.paused.status === 'fulfilled' ? outcome.paused.value : null;
      expect(loginResponse?.status).toBe(401);
      expect(await liveRefreshRowCount(user.id)).toBe(0);
    });

    it('is refused when the account is deleted first', async () => {
      const admin = await createPlatformAdmin(app);
      const user = await createRegularUser(app, 'racer@example.com');
      await loginPair(user.email);

      const paused = pauseIssuance();
      const outcome = await runRace(login(user.email), paused, () =>
        request(app.getHttpServer())
          .delete(`/api/users/${user.id}`)
          .set('Authorization', `Bearer ${admin.token}`)
          .expect(204),
      );

      const loginResponse =
        outcome.paused.status === 'fulfilled' ? outcome.paused.value : null;
      expect(loginResponse?.status).toBe(401);
      expect(await liveRefreshRowCount(user.id)).toBe(0);
      // And the account really is gone, not merely unable to log in.
      const deleted = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(deleted.deletedAt).not.toBeNull();
    });
  });

  // ── refresh racing each revocation path ──────────────────────────────────

  describe('refresh racing a revocation', () => {
    /**
     * The rotation seam is its own transaction, so the pause goes on the same
     * `issueForNewSession`-equivalent point: `rotate` itself. Parking before it
     * means the presented token has been read and validated against a snapshot
     * that the racer is about to invalidate.
     */
    const raceRefreshAgainst = async (
      email: string,
      racer: () => Promise<unknown>,
    ) => {
      const device = await loginPair(email);
      const paused = pauseBefore(refreshTokenService, 'rotate');
      const outcome = await runRace(
        request(app.getHttpServer())
          .post('/api/auth/refresh')
          .send({ refreshToken: device.refreshToken }),
        paused,
        racer,
      );
      return { device, outcome };
    };

    it('is refused when logout-all commits first', async () => {
      const user = await createRegularUser(app, 'racer@example.com');
      const opener = await loginPair(user.email);

      const { outcome } = await raceRefreshAgainst(user.email, () =>
        request(app.getHttpServer())
          .post('/api/auth/logout-all')
          .set('Authorization', `Bearer ${opener.accessToken}`)
          .expect(204),
      );

      const refreshResponse =
        outcome.paused.status === 'fulfilled' ? outcome.paused.value : null;
      expect(refreshResponse?.status).toBe(401);
      expect(await liveRefreshRowCount(user.id)).toBe(0);
    });

    it('is refused when a password change commits first', async () => {
      const user = await createRegularUser(app, 'racer@example.com');
      const opener = await loginPair(user.email);

      const { outcome } = await raceRefreshAgainst(user.email, () =>
        request(app.getHttpServer())
          .patch('/api/users/me/password')
          .set('Authorization', `Bearer ${opener.accessToken}`)
          .send({
            currentPassword: TEST_PASSWORD,
            newPassword: NEW_PASSWORD,
          })
          .expect(200),
      );

      const refreshResponse =
        outcome.paused.status === 'fulfilled' ? outcome.paused.value : null;
      expect(refreshResponse?.status).toBe(401);
      expect(await liveRefreshRowCount(user.id)).toBe(0);
    });

    it('is refused when support revokes the account first', async () => {
      const admin = await createPlatformAdmin(app);
      const user = await createRegularUser(app, 'racer@example.com');

      const { outcome } = await raceRefreshAgainst(user.email, () =>
        request(app.getHttpServer())
          .post(`/api/users/${user.id}/revoke-sessions`)
          .set('Authorization', `Bearer ${admin.token}`)
          .expect(204),
      );

      const refreshResponse =
        outcome.paused.status === 'fulfilled' ? outcome.paused.value : null;
      expect(refreshResponse?.status).toBe(401);
      expect(await liveRefreshRowCount(user.id)).toBe(0);
    });
  });

  // ── the non-race behaviour these changes must not break ──────────────────

  describe('ordinary sessions still work', () => {
    it('a normal login returns a usable access AND refresh token', async () => {
      const user = await createRegularUser(app, 'ordinary@example.com');

      const pair = await loginPair(user.email);

      expect(await accessTokenWorks(pair.accessToken)).toBe(true);
      expect(await refreshTokenWorks(pair.refreshToken)).toBe(true);
    });

    it('a password change is followed by a clean login on the new password', async () => {
      const user = await createRegularUser(app, 'rotator@example.com');
      const device = await loginPair(user.email);

      await request(app.getHttpServer())
        .patch('/api/users/me/password')
        .set('Authorization', `Bearer ${device.accessToken}`)
        .send({
          currentPassword: TEST_PASSWORD,
          newPassword: NEW_PASSWORD,
        })
        .expect(200);

      // The precondition must reject STALE logins, not correct ones. Getting
      // this wrong locks every user out of their own account after a rotation.
      const reissued = await loginPair(user.email, NEW_PASSWORD);
      expect(await accessTokenWorks(reissued.accessToken)).toBe(true);
      expect(await refreshTokenWorks(reissued.refreshToken)).toBe(true);
    });

    it('revoke-all kills every device, not just the one that asked', async () => {
      const user = await createRegularUser(app, 'multi@example.com');
      // The fixture logs in to obtain its token, so that session is already on
      // the account. Counted rather than assumed, so this stays true if the
      // fixture changes.
      const fixtureSessions = await liveRefreshRowCount(user.id);
      const phone = await loginPair(user.email);
      const laptop = await loginPair(user.email);
      const tablet = await loginPair(user.email);
      expect(await liveRefreshRowCount(user.id)).toBe(fixtureSessions + 3);

      await request(app.getHttpServer())
        .post('/api/auth/logout-all')
        .set('Authorization', `Bearer ${laptop.accessToken}`)
        .expect(204);

      expect(await liveRefreshRowCount(user.id)).toBe(0);
      for (const device of [phone, laptop, tablet]) {
        expect(await accessTokenWorks(device.accessToken)).toBe(false);
        expect(await refreshTokenWorks(device.refreshToken)).toBe(false);
      }
    });

    it('replaying a consumed refresh token still revokes the whole family', async () => {
      const user = await createRegularUser(app, 'replayer@example.com');
      const original = await loginPair(user.email);

      const rotated = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken: original.refreshToken })
        .expect(200);
      const child = rotated.body as TokenPair;

      // Re-presenting the consumed parent is RFC 9700 §4.14.2 reuse.
      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken: original.refreshToken })
        .expect(401);

      // The child dies with the family — that is the point of reuse detection.
      expect(await refreshTokenWorks(child.refreshToken)).toBe(false);
      // Scoped to the FAMILY, deliberately. Reuse detection ends the compromised
      // chain, not every session the account has: the user's other devices are
      // not evidence of theft, and killing them would make the control too
      // costly to keep enabled. `logout-all` is the tool for "end everything".
      const replayed = await prisma.refreshToken.findUniqueOrThrow({
        where: { tokenHash: hashOpaqueToken(original.refreshToken) },
        select: { familyId: true },
      });
      const familyRows = await prisma.refreshToken.findMany({
        where: { familyId: replayed.familyId },
        select: { revokedAt: true },
      });
      expect(familyRows).toHaveLength(2); // the parent and its one child
      expect(familyRows.every((row) => row.revokedAt !== null)).toBe(true);
      const replayAudit = await prisma.auditLog.findFirst({
        where: {
          action: 'auth.refresh_token.replay_detected',
          targetUserId: user.id,
        },
      });
      expect(replayAudit).not.toBeNull();
    });

    it('a routine password change is NOT audited as a replay', async () => {
      // The rotation backstop used to route a stale-cutoff token through the
      // theft path, putting a false `replay_detected` alert into the one log a
      // responder trusts.
      const user = await createRegularUser(app, 'quiet@example.com');
      const device = await loginPair(user.email);

      await request(app.getHttpServer())
        .patch('/api/users/me/password')
        .set('Authorization', `Bearer ${device.accessToken}`)
        .send({
          currentPassword: TEST_PASSWORD,
          newPassword: NEW_PASSWORD,
        })
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken: device.refreshToken })
        .expect(401);

      const replayAudit = await prisma.auditLog.findFirst({
        where: { action: 'auth.refresh_token.replay_detected' },
      });
      expect(replayAudit).toBeNull();
    });
  });

  // ── paths that previously ended only half a session ──────────────────────

  describe('every revocation path ends BOTH token kinds', () => {
    it('support revocation kills the access token, not only the refresh token', async () => {
      const admin = await createPlatformAdmin(app);
      const user = await createRegularUser(app, 'supported@example.com');
      const device = await loginPair(user.email);
      expect(await accessTokenWorks(device.accessToken)).toBe(true);

      await request(app.getHttpServer())
        .post(`/api/users/${user.id}/revoke-sessions`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(204);

      // Revoking rows alone left this working for up to `jwt.expiresIn` — 30
      // days in this template — which is most of the way to doing nothing.
      expect(await accessTokenWorks(device.accessToken)).toBe(false);
      expect(await refreshTokenWorks(device.refreshToken)).toBe(false);
    });

    it('changing the account email ends every session', async () => {
      const user = await createRegularUser(app, 'mover@example.com');
      const device = await loginPair(user.email);

      await request(app.getHttpServer())
        .patch('/api/users/me/email')
        .set('Authorization', `Bearer ${device.accessToken}`)
        .send({
          currentPassword: TEST_PASSWORD,
          newEmail: 'moved@example.com',
        })
        .expect(200);

      // The address is the account's identifier and its recovery channel, so
      // moving it is a credential change. `errors/README.md` has always said so.
      expect(await accessTokenWorks(device.accessToken)).toBe(false);
      expect(await refreshTokenWorks(device.refreshToken)).toBe(false);
      expect(await liveRefreshRowCount(user.id)).toBe(0);
    });

    it('deactivating an account ends every session', async () => {
      const admin = await createPlatformAdmin(app);
      const user = await createRegularUser(app, 'switched-off@example.com');
      const device = await loginPair(user.email);

      await request(app.getHttpServer())
        .patch(`/api/users/${user.id}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ isActive: false })
        .expect(200);

      expect(await accessTokenWorks(device.accessToken)).toBe(false);
      expect(await refreshTokenWorks(device.refreshToken)).toBe(false);
      // Live rows would otherwise be resurrected by a later reactivation.
      expect(await liveRefreshRowCount(user.id)).toBe(0);
    });
  });
});
