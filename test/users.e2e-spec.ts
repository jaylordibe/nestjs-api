import { INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuditService } from '../src/common/audit/audit.service';
import { JobName } from '../src/common/queue/job-registry';
import { QueueProducerService } from '../src/common/queue/queue-producer.service';
import { DestinationSendLimitService } from '../src/common/send-limit/destination-send-limit.service';
import { RefreshTokenService } from '../src/modules/auth/refresh-token.service';
import { UsersService } from '../src/modules/users/users.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { pauseBefore, runRace } from './setup/barrier';
import { createTestApp } from './setup/test-app';
import { truncateAll } from './setup/db';
import {
  captureEmails,
  deliverQueuedEmails,
  linkParameter,
} from './setup/emails';
import {
  createPlatformAdmin,
  createRegularUser,
  registerVerifiedUser,
  seedRbacCatalog,
} from './setup/rbac';
import { firstElement } from './setup/elements';

const PASSWORD = 'correct-horse-battery-1';

// Register, mark the row verified directly, and return an access token.
async function registerUser(
  app: INestApplication<App>,
  email = 'user@example.com',
): Promise<string> {
  const { token } = await registerVerifiedUser(app, email);
  return token;
}

describe('Users (e2e)', () => {
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

  describe('access control', () => {
    it('rejects unauthenticated requests with 401', async () => {
      await request(app.getHttpServer()).get('/api/users').expect(401);
    });

    it('rejects non-admin authenticated requests with 403', async () => {
      const token = await registerUser(app);
      await request(app.getHttpServer())
        .get('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });
  });

  describe('self-service', () => {
    it('GET /api/users/me returns the authenticated user', async () => {
      const { token } = await registerVerifiedUser(app, 'me@example.com');
      const res = await request(app.getHttpServer())
        .get('/api/users/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.email).toBe('me@example.com');
      expect(res.body).not.toHaveProperty('password');
    });

    it('GET /api/users/me rejects unauthenticated with 401', async () => {
      await request(app.getHttpServer()).get('/api/users/me').expect(401);
    });

    it('PATCH /api/users/me updates allowed profile fields only', async () => {
      const { token } = await registerVerifiedUser(app);
      const res = await request(app.getHttpServer())
        .patch('/api/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ firstName: 'Renamed', timezone: 'Asia/Manila' })
        .expect(200);
      expect(res.body.firstName).toBe('Renamed');
      expect(res.body.timezone).toBe('Asia/Manila');

      // Disallowed fields (role, email) rejected by the whitelist.
      await request(app.getHttpServer())
        .patch('/api/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'admin' })
        .expect(400);
    });

    it('DELETE /api/users/me soft-deletes (deletedAt + deletedBy set, isActive untouched) and blocks login', async () => {
      const { id, token } = await registerVerifiedUser(
        app,
        'self-del@example.com',
      );
      await request(app.getHttpServer())
        .delete('/api/users/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      const prisma = app.get(PrismaService);
      const row = await prisma.user.findUniqueOrThrow({ where: { id } });
      // isActive stays `true` — it's reserved for explicit suspension,
      // not double-signalling deletion. deletedAt is the lifecycle gate.
      expect(row.isActive).toBe(true);
      expect(row.deletedAt).not.toBeNull();
      expect(row.deletedBy).toBe(id);

      // Token invalidated via JwtStrategy's deletedAt check.
      await request(app.getHttpServer())
        .get('/api/users/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);

      // Login refuses the account even with the right password.
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ identifier: 'self-del@example.com', password: PASSWORD })
        .expect(401);
    });

    it('POST /api/users/me/gdpr-erase anonymizes PII and blocks login', async () => {
      const { id, token } = await registerVerifiedUser(
        app,
        'erase@example.com',
      );

      await request(app.getHttpServer())
        .post('/api/users/me/gdpr-erase')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: PASSWORD })
        .expect(204);

      const prisma = app.get(PrismaService);
      const row = await prisma.user.findUniqueOrThrow({ where: { id } });
      expect(row.email).not.toBe('erase@example.com');
      expect(row.email).toMatch(/^deleted-.+@deleted\.invalid$/);
      expect(row.firstName).toBe('Deleted');
      expect(row.phoneNumber).toBeNull();
      expect(row.deletedAt).not.toBeNull();
      expect(row.deletedBy).toBe(id);

      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ identifier: 'erase@example.com', password: PASSWORD })
        .expect(401);
    });

    it('POST /api/users/me/gdpr-erase rejects wrong password with 401', async () => {
      const { token } = await registerVerifiedUser(
        app,
        'wrong-erase@example.com',
      );
      await request(app.getHttpServer())
        .post('/api/users/me/gdpr-erase')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: 'definitely-not-right-1' })
        .expect(401);
    });

    it('PATCH /api/users/me/username changes username', async () => {
      const { token } = await registerVerifiedUser(app);
      const res = await request(app.getHttpServer())
        .patch('/api/users/me/username')
        .set('Authorization', `Bearer ${token}`)
        .send({ username: 'Handle_01' })
        .expect(200);
      expect(res.body.username).toBe('handle_01');
    });

    it('PATCH /api/users/me/username returns 409 on duplicate', async () => {
      const a = await registerVerifiedUser(app, 'a@example.com');
      await request(app.getHttpServer())
        .patch('/api/users/me/username')
        .set('Authorization', `Bearer ${a.token}`)
        .send({ username: 'taken' })
        .expect(200);

      const b = await registerVerifiedUser(app, 'b@example.com');
      await request(app.getHttpServer())
        .patch('/api/users/me/username')
        .set('Authorization', `Bearer ${b.token}`)
        .send({ username: 'taken' })
        .expect(409);
    });

    it('PATCH /api/users/me/email resets verification, emails the new address and returns a fresh session', async () => {
      const { id, token } = await registerVerifiedUser(app, 'old@example.com');
      await deliverQueuedEmails(app);
      const prisma = app.get(PrismaService);

      const emails = captureEmails(app);
      try {
        const res = await request(app.getHttpServer())
          .patch('/api/users/me/email')
          .set('Authorization', `Bearer ${token}`)
          .send({ newEmail: 'New@example.com', currentPassword: PASSWORD })
          .expect(200);
        expect(res.body.user.email).toBe('new@example.com');
        expect(res.body.user).not.toHaveProperty('emailVerifiedAt');
        expect(res.body).toMatchObject({
          accessToken: expect.any(String),
          refreshToken: expect.any(String),
          expiresIn: expect.any(Number),
        });
        const row = await prisma.user.findUniqueOrThrow({ where: { id } });
        expect(row.emailVerifiedAt).toBeNull();

        // The caller stays signed in on the returned token.
        await request(app.getHttpServer())
          .get('/api/users/me')
          .set('Authorization', `Bearer ${res.body.accessToken as string}`)
          .expect(200);

        await deliverQueuedEmails(app);
        // The new address gets its link; the verified previous address is
        // told, so a takeover cannot move the account's email silently.
        expect(
          emails.sent.map(({ to, template }) => ({ to, template })),
        ).toEqual(
          expect.arrayContaining([
            { to: 'new@example.com', template: 'email-verification-link' },
            { to: 'old@example.com', template: 'email-changed-notification' },
          ]),
        );
        expect(emails.sent).toHaveLength(2);
        const audit = await prisma.auditLog.findFirstOrThrow({
          where: { action: 'user.email_changed', targetUserId: id },
        });
        expect(audit.actorId).toBe(id);
        expect(audit.metadata).toMatchObject({
          previousEmail: 'old@example.com',
          newEmail: 'new@example.com',
        });
      } finally {
        emails.restore();
      }
    });

    // An unverified address was never proven to be the owner's, so moving
    // away from it tells it nothing — otherwise switching an account's email
    // back and forth would mail an inbox the account never controlled.
    it('PATCH /api/users/me/email tells nothing to a previous address that was never verified', async () => {
      const { token } = await registerVerifiedUser(app, 'first@example.com');
      const moved = await request(app.getHttpServer())
        .patch('/api/users/me/email')
        .set('Authorization', `Bearer ${token}`)
        .send({ newEmail: 'second@example.com', currentPassword: PASSWORD })
        .expect(200);
      await deliverQueuedEmails(app);

      const emails = captureEmails(app);
      try {
        await request(app.getHttpServer())
          .patch('/api/users/me/email')
          .set('Authorization', `Bearer ${moved.body.accessToken as string}`)
          .send({ newEmail: 'third@example.com', currentPassword: PASSWORD })
          .expect(200);
        await deliverQueuedEmails(app);

        expect(
          emails.sent.map(({ to, template }) => ({ to, template })),
        ).toEqual([
          { to: 'third@example.com', template: 'email-verification-link' },
        ]);
      } finally {
        emails.restore();
      }
    });

    it('PATCH /api/users/me/email to the current address records no change and tells nobody', async () => {
      const { id, token } = await registerVerifiedUser(app, 'same@example.com');
      await deliverQueuedEmails(app);
      const emails = captureEmails(app);
      try {
        await request(app.getHttpServer())
          .patch('/api/users/me/email')
          .set('Authorization', `Bearer ${token}`)
          .send({ newEmail: 'Same@Example.com', currentPassword: PASSWORD })
          .expect(200);
        await deliverQueuedEmails(app);

        expect(emails.sent.map((email) => email.template)).not.toContain(
          'email-changed-notification',
        );
        expect(
          await app.get(PrismaService).auditLog.count({
            where: { action: 'user.email_changed', targetUserId: id },
          }),
        ).toBe(0);
      } finally {
        emails.restore();
      }
    });

    // The audit write is best-effort; when it fails the change still
    // succeeds, and the notice — which needs the row — is simply not queued.
    it('PATCH /api/users/me/email still succeeds when the audit write fails', async () => {
      const { token } = await registerVerifiedUser(
        app,
        'audit-down@example.com',
      );
      await deliverQueuedEmails(app);
      const auditService = app.get(AuditService);
      const record = auditService.record.bind(auditService);
      const spy = jest
        .spyOn(auditService, 'record')
        .mockImplementation((entry) =>
          entry.action === 'user.email_changed'
            ? Promise.resolve(null)
            : record(entry),
        );
      const emails = captureEmails(app);
      try {
        await request(app.getHttpServer())
          .patch('/api/users/me/email')
          .set('Authorization', `Bearer ${token}`)
          .send({ newEmail: 'moved@example.com', currentPassword: PASSWORD })
          .expect(200);
        await deliverQueuedEmails(app);

        expect(emails.sent.map((email) => email.template)).toEqual([
          'email-verification-link',
        ]);
      } finally {
        emails.restore();
        spy.mockRestore();
      }
    });

    // The change has committed by the time the notice is queued; a queue
    // failure for the notice must not fail the request or skip the link.
    it('PATCH /api/users/me/email still succeeds when the notice cannot be queued', async () => {
      const { token } = await registerVerifiedUser(
        app,
        'queue-down@example.com',
      );
      await deliverQueuedEmails(app);
      const producer = app.get(QueueProducerService);
      const enqueue = producer.enqueue.bind(producer);
      const spy = jest
        .spyOn(producer, 'enqueue')
        .mockImplementation((jobName, payload) =>
          jobName === JobName.USER_EMAIL_CHANGED_NOTICE_V1
            ? Promise.reject(new Error('Connection is closed.'))
            : enqueue(jobName, payload),
        );
      const emails = captureEmails(app);
      try {
        await request(app.getHttpServer())
          .patch('/api/users/me/email')
          .set('Authorization', `Bearer ${token}`)
          .send({ newEmail: 'queued@example.com', currentPassword: PASSWORD })
          .expect(200);
        await deliverQueuedEmails(app);

        expect(emails.sent.map((email) => email.template)).toEqual([
          'email-verification-link',
        ]);
      } finally {
        emails.restore();
        spy.mockRestore();
      }
    });

    // The worker trusts only an email-change row about the payload's own user:
    // a mismatched id must never mail some other address.
    it('sends no email-changed notice for an audit row that is not that user\u2019s email change', async () => {
      const first = await registerVerifiedUser(app, 'one@example.com');
      const second = await registerVerifiedUser(app, 'two@example.com');
      await request(app.getHttpServer())
        .patch('/api/users/me/email')
        .set('Authorization', `Bearer ${second.token}`)
        .send({ newEmail: 'two-new@example.com', currentPassword: PASSWORD })
        .expect(200);
      await deliverQueuedEmails(app);
      const prisma = app.get(PrismaService);
      const othersChange = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'user.email_changed', targetUserId: second.id },
      });
      const unrelated = await prisma.auditLog.create({
        data: {
          action: 'user.updated.by_admin',
          targetUserId: first.id,
          metadata: { previousEmail: 'stranger@example.com' },
        },
      });
      const producer = app.get(QueueProducerService);
      for (const auditLogId of [othersChange.id, unrelated.id]) {
        await producer.enqueue(JobName.USER_EMAIL_CHANGED_NOTICE_V1, {
          payloadVersion: 1,
          userId: first.id,
          auditLogId,
        });
      }
      const emails = captureEmails(app);
      try {
        await deliverQueuedEmails(app);

        expect(emails.sent).toEqual([]);
      } finally {
        emails.restore();
      }
    });

    it('PATCH /api/users/me/email rejects wrong current password with 401', async () => {
      const { token } = await registerVerifiedUser(app);
      await request(app.getHttpServer())
        .patch('/api/users/me/email')
        .set('Authorization', `Bearer ${token}`)
        .send({
          newEmail: 'x@example.com',
          currentPassword: 'wrong-password-1',
        })
        .expect(401);
    });

    // A current password over 72 bytes can never match a stored one: refused
    // as input, before bcrypt, on every route that checks one.
    it('PATCH /api/users/me/password refuses a current password over 72 bytes', async () => {
      const { token } = await registerVerifiedUser(app, 'pw-bytes@example.com');
      const res = await request(app.getHttpServer())
        .patch('/api/users/me/password')
        .set('Authorization', `Bearer ${token}`)
        .send({
          currentPassword: `${'ñ'.repeat(36)}a1`,
          newPassword: 'new-password-1',
        })
        .expect(400);
      expect(res.body.errorCode).toBe('VALIDATION_FAILED');
    });

    it('PATCH /api/users/me/password requires current password and keeps the caller signed in', async () => {
      const { token } = await registerVerifiedUser(app, 'pw@example.com');
      await request(app.getHttpServer())
        .patch('/api/users/me/password')
        .set('Authorization', `Bearer ${token}`)
        .send({
          currentPassword: 'wrong-password-1',
          newPassword: 'new-password-1',
        })
        .expect(401);

      const res = await request(app.getHttpServer())
        .patch('/api/users/me/password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: PASSWORD, newPassword: 'new-password-1' })
        .expect(200);
      expect(res.body.user.email).toBe('pw@example.com');
      await request(app.getHttpServer())
        .get('/api/users/me')
        .set('Authorization', `Bearer ${res.body.accessToken as string}`)
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ identifier: 'pw@example.com', password: 'new-password-1' })
        .expect(200);
    });

    it('PATCH /api/users/me/password takes the sign-up rule: 8 characters, not 7', async () => {
      const { token } = await registerVerifiedUser(app, 'pw-rule@example.com');
      const refused = await request(app.getHttpServer())
        .patch('/api/users/me/password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: PASSWORD, newPassword: 'secret1' })
        .expect(400);
      expect(refused.body.errorCode).toBe('VALIDATION_FAILED');

      await request(app.getHttpServer())
        .patch('/api/users/me/password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: PASSWORD, newPassword: 'secret12' })
        .expect(200);
    });

    // Profile images are uploaded files now (`POST /files`, then
    // `PUT /users/me/profile-image { fileId }`). The old URL-taking PATCH on
    // that path is gone, and a client still sending it gets a clear refusal
    // rather than a silently ignored field.
    it('no longer serves PATCH /api/users/me/profile-image', async () => {
      const { token } = await registerVerifiedUser(app);
      await request(app.getHttpServer())
        .patch('/api/users/me/profile-image')
        .set('Authorization', `Bearer ${token}`)
        .send({ profileImageUrl: 'https://cdn.example.com/me.jpg' })
        .expect(404);
    });

    it('POST /api/users/me/request-phone-verification rejects wrong current password with 401', async () => {
      // Re-auth gate (Phase C): a stolen JWT alone must not be able to
      // redirect the user's phone number — the kickoff requires the
      // current password, mirroring the email-change request endpoint.
      const { id, token } = await registerVerifiedUser(
        app,
        'phone-bad@example.com',
      );
      await request(app.getHttpServer())
        .post('/api/users/me/request-phone-verification')
        .set('Authorization', `Bearer ${token}`)
        .send({ phoneNumber: '+14155550100', currentPassword: 'wrong-pass-1' })
        .expect(401);
      // No OTP was issued on the failed re-auth.
      const prisma = app.get(PrismaService);
      const row = await prisma.user.findUniqueOrThrow({ where: { id } });
      expect(row.otpHash).toBeNull();
    });

    it('phone-verification flow stamps phoneNumberVerifiedAt on a valid OTP', async () => {
      const { id, token } = await registerVerifiedUser(
        app,
        'phone-ok@example.com',
      );
      const prisma = app.get(PrismaService);
      const phoneNumber = '+14155550111';

      // Kicking off the flow requires the current password (re-auth).
      await request(app.getHttpServer())
        .post('/api/users/me/request-phone-verification')
        .set('Authorization', `Bearer ${token}`)
        .send({ phoneNumber, currentPassword: PASSWORD })
        .expect(200);

      // The stub SMS adapter doesn't surface the code, so plant a known
      // OTP hash bound to the target number (matching the service's
      // `${otp}:${phoneNumber}` binding) to drive the verify step.
      const otp = '135790';
      await prisma.user.update({
        where: { id },
        data: {
          otpHash: await bcrypt.hash(`${otp}:${phoneNumber}`, 10),
          otpPurpose: 'phone_verify',
          otpExpiresAt: new Date(Date.now() + 10 * 60_000),
        },
      });

      const res = await request(app.getHttpServer())
        .patch('/api/users/me/verify-phone')
        .set('Authorization', `Bearer ${token}`)
        .send({ phoneNumber, otp })
        .expect(200);
      expect(res.body.phoneNumber).toBe(phoneNumber);
      expect(res.body.phoneNumberVerifiedAt).toEqual(expect.any(String));

      const row = await prisma.user.findUniqueOrThrow({ where: { id } });
      expect(row.phoneNumberVerifiedAt).not.toBeNull();
      // OTP triple is cleared after a successful verify (single-use).
      expect(row.otpHash).toBeNull();
      expect(row.otpPurpose).toBeNull();
    });

    it('PATCH /api/users/me/verify-phone rejects a wrong OTP with 400 (opaque)', async () => {
      const { id, token } = await registerVerifiedUser(
        app,
        'phone-otp@example.com',
      );
      const prisma = app.get(PrismaService);
      const phoneNumber = '+14155550122';
      await prisma.user.update({
        where: { id },
        data: {
          otpHash: await bcrypt.hash(`246810:${phoneNumber}`, 10),
          otpPurpose: 'phone_verify',
          otpExpiresAt: new Date(Date.now() + 10 * 60_000),
        },
      });
      const res = await request(app.getHttpServer())
        .patch('/api/users/me/verify-phone')
        .set('Authorization', `Bearer ${token}`)
        .send({ phoneNumber, otp: '000000' })
        .expect(400);
      expect(res.body.errorCode).toBe('INVALID_OTP');
    });

    describe('password reset link', () => {
      // Requests a reset for `email` and returns the token from the emailed link.
      async function requestResetToken(email: string): Promise<string> {
        await deliverQueuedEmails(app);
        const emails = captureEmails(app);
        try {
          await request(app.getHttpServer())
            .post('/api/users/request-password-reset')
            .send({ email })
            .expect(200);
          await deliverQueuedEmails(app);
          expect(emails.sent).toHaveLength(1);
          expect(emails.sent[0]).toMatchObject({
            to: email,
            template: 'password-reset-link',
          });
          expect(
            linkParameter(
              firstElement(emails.sent, 'sent email'),
              'resetUrl',
              'email',
            ),
          ).toBe(email);
          return linkParameter(
            firstElement(emails.sent, 'sent email'),
            'resetUrl',
            'token',
          );
        } finally {
          emails.restore();
        }
      }

      function resetPassword(
        email: string,
        token: string,
        newPassword = 'brand-new-pw-1',
      ) {
        return request(app.getHttpServer())
          .post('/api/users/reset-password')
          .send({ email, token, newPassword });
      }

      it('answers 200 for any address and emails only a registered one', async () => {
        await registerVerifiedUser(app, 'reset@example.com');
        await deliverQueuedEmails(app);
        const emails = captureEmails(app);
        try {
          await request(app.getHttpServer())
            .post('/api/users/request-password-reset')
            .send({ email: 'reset@example.com' })
            .expect(200);
          await request(app.getHttpServer())
            .post('/api/users/request-password-reset')
            .send({ email: 'ghost@example.com' })
            .expect(200);
          await deliverQueuedEmails(app);
          expect(emails.sent.map((email) => email.to)).toEqual([
            'reset@example.com',
          ]);
        } finally {
          emails.restore();
        }
      });

      it('stores only a hash of the token', async () => {
        const { id } = await registerVerifiedUser(app, 'hash@example.com');
        const token = await requestResetToken('hash@example.com');
        const row = await app
          .get(PrismaService)
          .user.findUniqueOrThrow({ where: { id } });
        expect(row.otpHash).not.toBe(token);
        expect(row.otpHash).toMatch(/^[a-f0-9]{64}$/);
        expect(row.otpPurpose).toBe('password_reset');
      });

      it('resets the password with the emailed token, once', async () => {
        await registerVerifiedUser(app, 'flow@example.com');
        const token = await requestResetToken('flow@example.com');

        await resetPassword('flow@example.com', token).expect(200);
        await request(app.getHttpServer())
          .post('/api/auth/login')
          .send({ identifier: 'flow@example.com', password: PASSWORD })
          .expect(401);
        await request(app.getHttpServer())
          .post('/api/auth/login')
          .send({ identifier: 'flow@example.com', password: 'brand-new-pw-1' })
          .expect(200);

        const replay = await resetPassword('flow@example.com', token).expect(
          400,
        );
        expect(replay.body.errorCode).toBe('INVALID_LINK');
      });

      it('takes the sign-up rule: a 7-character password is refused and leaves the link usable, 8 is accepted', async () => {
        await registerVerifiedUser(app, 'reset-rule@example.com');
        const token = await requestResetToken('reset-rule@example.com');

        const refused = await resetPassword(
          'reset-rule@example.com',
          token,
          'secret1',
        ).expect(400);
        expect(refused.body.errorCode).toBe('VALIDATION_FAILED');

        await resetPassword('reset-rule@example.com', token, 'secret12').expect(
          200,
        );
        await request(app.getHttpServer())
          .post('/api/auth/login')
          .send({ identifier: 'reset-rule@example.com', password: 'secret12' })
          .expect(200);
      });

      it('refuses a new password over 72 bytes and leaves the link usable', async () => {
        await createRegularUser(app, 'reset-bytes@example.com');
        const token = await requestResetToken('reset-bytes@example.com');

        const refused = await resetPassword(
          'reset-bytes@example.com',
          token,
          `${'ñ'.repeat(36)}a1`,
        ).expect(400);
        expect(refused.body.errorCode).toBe('VALIDATION_FAILED');

        await resetPassword('reset-bytes@example.com', token).expect(200);
      });

      it("rejects a wrong token or another account's email with 400 INVALID_LINK", async () => {
        await registerVerifiedUser(app, 'wrong-token@example.com');
        await registerVerifiedUser(app, 'other@example.com');
        const token = await requestResetToken('wrong-token@example.com');

        const wrongToken = await resetPassword(
          'wrong-token@example.com',
          `${token}x`,
        ).expect(400);
        expect(wrongToken.body.errorCode).toBe('INVALID_LINK');
        await resetPassword('other@example.com', token).expect(400);
      });

      it('rejects an expired token', async () => {
        const { id } = await registerVerifiedUser(app, 'expired@example.com');
        const token = await requestResetToken('expired@example.com');
        await app.get(PrismaService).user.update({
          where: { id },
          data: { otpExpiresAt: new Date(Date.now() - 1_000) },
        });
        await resetPassword('expired@example.com', token).expect(400);
      });

      function signInStatus(email: string, password: string): Promise<number> {
        return request(app.getHttpServer())
          .post('/api/auth/login')
          .send({ identifier: email, password })
          .then((response) => response.status);
      }

      // Single use must hold when two redemptions overlap, not only in
      // sequence. The first request is parked after its token check and its
      // password hash — just before it takes the account lock — while the
      // second redeems the same link to completion.
      it('redeems a link once when two redemptions race: the loser gets INVALID_LINK', async () => {
        const { id } = await createRegularUser(app, 'race@example.com');
        const token = await requestResetToken('race@example.com');

        const paused = pauseBefore(
          app.get(RefreshTokenService),
          'lockSessions',
        );
        const outcome = await runRace(
          resetPassword('race@example.com', token, 'first-racer-pw-1'),
          paused,
          () => resetPassword('race@example.com', token, 'second-racer-pw-2'),
        );

        expect(outcome.racer).toMatchObject({
          status: 'fulfilled',
          value: { status: 200 },
        });
        expect(outcome.paused).toMatchObject({
          status: 'fulfilled',
          value: { status: 400, body: { errorCode: 'INVALID_LINK' } },
        });
        expect(
          await signInStatus('race@example.com', 'second-racer-pw-2'),
        ).toBe(200);
        expect(await signInStatus('race@example.com', 'first-racer-pw-1')).toBe(
          401,
        );
        const prisma = app.get(PrismaService);
        const row = await prisma.user.findUniqueOrThrow({ where: { id } });
        expect(row).toMatchObject({
          otpHash: null,
          otpPurpose: null,
          otpExpiresAt: null,
        });
        expect(
          await prisma.auditLog.count({
            where: { action: 'password.reset.completed', targetUserId: id },
          }),
        ).toBe(1);
      });

      it('refuses an older link once a newer one was sent while it was being redeemed', async () => {
        const { id } = await createRegularUser(app, 'remint@example.com');
        const oldToken = await requestResetToken('remint@example.com');
        // The newer link, written as the reset worker writes it, so the test
        // does not depend on the address's send budget for a second email.
        const newToken = 'b'.repeat(64);
        const prisma = app.get(PrismaService);

        const paused = pauseBefore(
          app.get(RefreshTokenService),
          'lockSessions',
        );
        const outcome = await runRace(
          resetPassword('remint@example.com', oldToken),
          paused,
          () =>
            prisma.user.update({
              where: { id },
              data: {
                otpHash: createHash('sha256').update(newToken).digest('hex'),
                otpPurpose: 'password_reset',
                otpExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
              },
            }),
        );

        expect(outcome.paused).toMatchObject({
          status: 'fulfilled',
          value: { status: 400, body: { errorCode: 'INVALID_LINK' } },
        });
        await resetPassword('remint@example.com', newToken).expect(200);
      });

      it('cancels a pending link when the password is changed', async () => {
        const { token: accessToken } = await createRegularUser(
          app,
          'changed-pw@example.com',
        );
        const token = await requestResetToken('changed-pw@example.com');

        await request(app.getHttpServer())
          .patch('/api/users/me/password')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ currentPassword: PASSWORD, newPassword: 'changed-pw-2' })
          .expect(200);

        const refused = await resetPassword(
          'changed-pw@example.com',
          token,
        ).expect(400);
        expect(refused.body.errorCode).toBe('INVALID_LINK');
      });

      it('cancels a pending link when the email is changed, so the old mailbox cannot reset the new address', async () => {
        const { token: accessToken } = await createRegularUser(
          app,
          'old-mailbox@example.com',
        );
        const token = await requestResetToken('old-mailbox@example.com');

        await request(app.getHttpServer())
          .patch('/api/users/me/email')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({
            newEmail: 'new-mailbox@example.com',
            currentPassword: PASSWORD,
          })
          .expect(200);

        const refused = await resetPassword(
          'new-mailbox@example.com',
          token,
        ).expect(400);
        expect(refused.body.errorCode).toBe('INVALID_LINK');
      });

      it('cancels a pending link when an admin changes the email or sets the password', async () => {
        const { token: adminToken } = await createPlatformAdmin(
          app,
          'reset-admin@example.com',
        );
        const moved = await createRegularUser(app, 'admin-moved@example.com');
        const movedToken = await requestResetToken('admin-moved@example.com');
        await request(app.getHttpServer())
          .patch(`/api/users/${moved.id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ email: 'admin-moved-new@example.com' })
          .expect(200);
        const movedRefused = await resetPassword(
          'admin-moved-new@example.com',
          movedToken,
        ).expect(400);
        expect(movedRefused.body.errorCode).toBe('INVALID_LINK');

        const reset = await createRegularUser(app, 'admin-set@example.com');
        const resetToken = await requestResetToken('admin-set@example.com');
        await request(app.getHttpServer())
          .patch(`/api/users/${reset.id}/password`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ newPassword: 'admin-set-pw-1' })
          .expect(200);
        const setRefused = await resetPassword(
          'admin-set@example.com',
          resetToken,
        ).expect(400);
        expect(setRefused.body.errorCode).toBe('INVALID_LINK');
      });

      it('cancels a pending link when an admin moves the email while deactivating', async () => {
        const { token: adminToken } = await createPlatformAdmin(
          app,
          'reset-admin-deactivate@example.com',
        );
        const moved = await createRegularUser(
          app,
          'deactivated-move@example.com',
        );
        const token = await requestResetToken('deactivated-move@example.com');

        await request(app.getHttpServer())
          .patch(`/api/users/${moved.id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ email: 'deactivated-move-new@example.com', isActive: false })
          .expect(200);
        await request(app.getHttpServer())
          .patch(`/api/users/${moved.id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ isActive: true })
          .expect(200);

        const refused = await resetPassword(
          'deactivated-move-new@example.com',
          token,
        ).expect(400);
        expect(refused.body.errorCode).toBe('INVALID_LINK');
      });

      // An admin form that re-sends the address it already holds moves
      // nothing, so it leaves the user's reset link alone.
      it('keeps a pending link when an admin re-sends the same email', async () => {
        const { token: adminToken } = await createPlatformAdmin(
          app,
          'reset-admin-same@example.com',
        );
        const kept = await createRegularUser(app, 'same-email@example.com');
        const token = await requestResetToken('same-email@example.com');

        await request(app.getHttpServer())
          .patch(`/api/users/${kept.id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ email: 'same-email@example.com', firstName: 'Renamed' })
          .expect(200);

        await resetPassword('same-email@example.com', token).expect(200);
      });

      // A link that expires while its redemption is hashing the new password
      // is refused under the lock, not honoured on the unlocked check.
      it('refuses a link that expired while it was being redeemed', async () => {
        const { id } = await createRegularUser(app, 'expiring@example.com');
        const token = await requestResetToken('expiring@example.com');
        const prisma = app.get(PrismaService);

        const paused = pauseBefore(
          app.get(RefreshTokenService),
          'lockSessions',
        );
        const outcome = await runRace(
          resetPassword('expiring@example.com', token),
          paused,
          () =>
            prisma.user.update({
              where: { id },
              data: { otpExpiresAt: new Date(Date.now() - 1_000) },
            }),
        );

        expect(outcome.paused).toMatchObject({
          status: 'fulfilled',
          value: { status: 400, body: { errorCode: 'INVALID_LINK' } },
        });
        expect(await signInStatus('expiring@example.com', PASSWORD)).toBe(200);
      });

      // The reset email job reads the account without a lock, then mints. An
      // email change committing in between finds no link to cancel; the mint
      // must then lose, or the old mailbox gets a link that resets the
      // account at its new address.
      it('mints no link when the email changes while the reset email is being prepared', async () => {
        const { id, token: accessToken } = await createRegularUser(
          app,
          'mint-race@example.com',
        );
        await deliverQueuedEmails(app);
        const emails = captureEmails(app);
        try {
          const paused = pauseBefore(
            app.get(DestinationSendLimitService),
            'sendWithinLimit',
          );
          const outcome = await runRace(
            app.get(UsersService).deliverPasswordReset(id),
            paused,
            () =>
              request(app.getHttpServer())
                .patch('/api/users/me/email')
                .set('Authorization', `Bearer ${accessToken}`)
                .send({
                  newEmail: 'mint-race-new@example.com',
                  currentPassword: PASSWORD,
                })
                .then((response) => response.status),
          );

          expect(outcome.racer).toMatchObject({
            status: 'fulfilled',
            value: 200,
          });
          expect(outcome.paused).toMatchObject({
            status: 'fulfilled',
            value: 'nothing-to-send',
          });
          const row = await app
            .get(PrismaService)
            .user.findUniqueOrThrow({ where: { id } });
          expect(row.otpPurpose).toBeNull();
          expect(
            emails.sent.filter(
              (email) => email.template === 'password-reset-link',
            ),
          ).toEqual([]);
        } finally {
          emails.restore();
        }
      });

      it('mints no link when the password changes while the reset email is being prepared', async () => {
        const { id, token: accessToken } = await createRegularUser(
          app,
          'mint-pw-race@example.com',
        );
        await deliverQueuedEmails(app);
        const emails = captureEmails(app);
        try {
          const paused = pauseBefore(
            app.get(DestinationSendLimitService),
            'sendWithinLimit',
          );
          const outcome = await runRace(
            app.get(UsersService).deliverPasswordReset(id),
            paused,
            () =>
              request(app.getHttpServer())
                .patch('/api/users/me/password')
                .set('Authorization', `Bearer ${accessToken}`)
                .send({
                  currentPassword: PASSWORD,
                  newPassword: 'mint-race-pw-2',
                })
                .then((response) => response.status),
          );

          expect(outcome.racer).toMatchObject({
            status: 'fulfilled',
            value: 200,
          });
          expect(outcome.paused).toMatchObject({
            status: 'fulfilled',
            value: 'nothing-to-send',
          });
          const row = await app
            .get(PrismaService)
            .user.findUniqueOrThrow({ where: { id } });
          expect(row.otpPurpose).toBeNull();
          expect(
            emails.sent.filter(
              (email) => email.template === 'password-reset-link',
            ),
          ).toEqual([]);
        } finally {
          emails.restore();
        }
      });

      // Signing out everywhere moves the session cutoff but changes neither
      // the address nor the password: a reset requested just before must
      // still be sent.
      it('still sends the link when the account signs out everywhere meanwhile', async () => {
        const { id, token: accessToken } = await createRegularUser(
          app,
          'logout-all-race@example.com',
        );
        await deliverQueuedEmails(app);
        const emails = captureEmails(app);
        try {
          const paused = pauseBefore(
            app.get(DestinationSendLimitService),
            'sendWithinLimit',
          );
          const outcome = await runRace(
            app.get(UsersService).deliverPasswordReset(id),
            paused,
            () =>
              request(app.getHttpServer())
                .post('/api/auth/logout-all')
                .set('Authorization', `Bearer ${accessToken}`)
                .then((response) => response.status),
          );

          expect(outcome.racer).toMatchObject({
            status: 'fulfilled',
            value: 204,
          });
          expect(outcome.paused).toMatchObject({
            status: 'fulfilled',
            value: 'sent',
          });
          expect(
            emails.sent.filter(
              (email) => email.template === 'password-reset-link',
            ),
          ).toHaveLength(1);
        } finally {
          emails.restore();
        }
      });

      // The otp slot is shared; cancelling a reset link must not wipe a code
      // issued for another purpose.
      it('leaves a pending phone-verification code alone when the password is changed', async () => {
        const { id, token: accessToken } = await createRegularUser(
          app,
          'phone-code@example.com',
        );
        const prisma = app.get(PrismaService);
        const phoneCode = {
          otpHash: 'c'.repeat(64),
          otpPurpose: 'phone_verify',
          otpExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
        };
        await prisma.user.update({ where: { id }, data: phoneCode });

        await request(app.getHttpServer())
          .patch('/api/users/me/password')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ currentPassword: PASSWORD, newPassword: 'changed-pw-3' })
          .expect(200);

        const row = await prisma.user.findUniqueOrThrow({ where: { id } });
        expect(row).toMatchObject(phoneCode);
      });
    });

    it('GET /api/users/me/export returns the user JSON', async () => {
      const { token } = await registerVerifiedUser(app, 'export@example.com');
      const res = await request(app.getHttpServer())
        .get('/api/users/me/export')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.email).toBe('export@example.com');
      expect(res.body).not.toHaveProperty('password');
    });
  });

  describe('as ADMIN', () => {
    let adminToken: string;
    let adminId: string;

    beforeEach(async () => {
      ({ id: adminId, token: adminToken } = await createPlatformAdmin(app));
    });

    // A date-time without an offset is read in the process's zone, so the day
    // stored moves on any host not in UTC — back east of it at midnight,
    // forward west of it late at night — unless the process runs in the
    // application zone.
    it.each(['T00:00:00', 'T23:59:59'])(
      'POST /api/users stores the birthday a date-time without an offset names (%s), whatever the host zone',
      async (timeOfDay) => {
        const res = await request(app.getHttpServer())
          .post('/api/users')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            email: 'birthday@example.com',
            password: PASSWORD,
            firstName: 'Birth',
            lastName: 'Day',
            birthday: `1990-05-15${timeOfDay}`,
          })
          .expect(201);

        const stored = await app
          .get(PrismaService)
          .user.findUniqueOrThrow({ where: { id: res.body.id as string } });
        expect(stored.birthday?.toISOString().slice(0, 10)).toBe('1990-05-15');
      },
    );

    // The admin create/update bodies used to accept any URL as a profile
    // image. That field is gone: an image is an uploaded file the person
    // attaches themselves.
    it('refuses profileImageUrl on POST /api/users and PATCH /api/users/:id', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          email: 'url-field@example.com',
          password: PASSWORD,
          firstName: 'Url',
          lastName: 'Field',
          profileImageUrl: 'https://cdn.example.com/me.jpg',
        })
        .expect(400);
      expect(created.body.errorCode).toBe('VALIDATION_FAILED');

      const updated = await request(app.getHttpServer())
        .patch(`/api/users/${adminId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ profileImageUrl: 'https://cdn.example.com/me.jpg' })
        .expect(400);
      expect(updated.body.errorCode).toBe('VALIDATION_FAILED');
    });

    it('GET /api/users returns a paginated list', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body).toMatchObject({
        meta: { page: 1, perPage: 20, total: 1, totalPages: 1 },
      });
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        email: 'admin@example.com',
      });
      // `role` is gone from the user representation entirely — authorization
      // lives in `user_roles` / `workspace_members`, never on the user row.
      expect(res.body.data[0]).not.toHaveProperty('role');
      expect(res.body.data[0]).not.toHaveProperty('password');
    });

    // P2002 → 409 envelope contract.
    it('POST /api/users emits the UNIQUE_CONSTRAINT_VIOLATION envelope on a duplicate email', async () => {
      const newUser = {
        email: 'dup-admin@example.com',
        password: PASSWORD,
        firstName: 'Dup',
        lastName: 'User',
      };
      await request(app.getHttpServer())
        .post('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(newUser)
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ ...newUser, firstName: 'Second' })
        .expect(409);

      expect(res.body.errorCode).toBe('UNIQUE_CONSTRAINT_VIOLATION');
      expect(res.body).toMatchObject({
        statusCode: 409,
        error: 'Conflict',
        details: { field: 'email' },
        path: '/api/users',
      });
      expect(typeof res.body.timestamp).toBe('string');
    });

    it('GET /api/users honors page and perPage query params', async () => {
      await request(app.getHttpServer())
        .post('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          email: 'second@example.com',
          password: PASSWORD,
          firstName: 'Second',
          lastName: 'User',
        });

      const page1 = await request(app.getHttpServer())
        .get('/api/users?page=1&perPage=1')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(page1.body.meta).toEqual({
        page: 1,
        perPage: 1,
        total: 2,
        totalPages: 2,
      });
      expect(page1.body.data).toHaveLength(1);

      const page2 = await request(app.getHttpServer())
        .get('/api/users?page=2&perPage=1')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.data[0].id).not.toBe(page1.body.data[0].id);
    });

    it('GET /api/users rejects invalid pagination params with 400', async () => {
      await request(app.getHttpServer())
        .get('/api/users?page=0')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
      await request(app.getHttpServer())
        .get('/api/users?perPage=0')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('GET /api/users clamps perPage above 100 to 100', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/users?perPage=9999')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body.meta.perPage).toBe(100);
    });

    it('POST /api/users creates a user and emails them a verification link', async () => {
      await deliverQueuedEmails(app);
      const emails = captureEmails(app);
      try {
        const res = await request(app.getHttpServer())
          .post('/api/users')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            email: 'new@example.com',
            password: PASSWORD,
            firstName: 'New',
            lastName: 'Person',
          })
          .expect(201);
        expect(res.body).toMatchObject({
          email: 'new@example.com',
          isActive: true,
        });
        expect(res.body).not.toHaveProperty('password');

        await deliverQueuedEmails(app);
        expect(emails.sent).toHaveLength(1);
        expect(emails.sent[0]).toMatchObject({
          to: 'new@example.com',
          template: 'email-verification-link',
        });
      } finally {
        emails.restore();
      }
    });

    it('PATCH /api/users/:id with a new email resets verification and emails the new address', async () => {
      const target = await registerVerifiedUser(app, 'before@example.com');
      await deliverQueuedEmails(app);
      const emails = captureEmails(app);
      try {
        await request(app.getHttpServer())
          .patch(`/api/users/${target.id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ email: 'after@example.com' })
          .expect(200);
        const row = await app
          .get(PrismaService)
          .user.findUniqueOrThrow({ where: { id: target.id } });
        expect(row.email).toBe('after@example.com');
        expect(row.emailVerifiedAt).toBeNull();

        await deliverQueuedEmails(app);
        // The verified previous address is told about the change too.
        expect(
          emails.sent.map(({ to, template }) => ({ to, template })),
        ).toEqual(
          expect.arrayContaining([
            { to: 'after@example.com', template: 'email-verification-link' },
            {
              to: 'before@example.com',
              template: 'email-changed-notification',
            },
          ]),
        );
        expect(emails.sent).toHaveLength(2);
        const audit = await app.get(PrismaService).auditLog.findFirstOrThrow({
          where: { action: 'user.email_changed', targetUserId: target.id },
        });
        expect(audit.actorId).toBe(adminId);
        expect(audit.metadata).toMatchObject({
          previousEmail: 'before@example.com',
          newEmail: 'after@example.com',
        });
      } finally {
        emails.restore();
      }
    });

    it('PATCH /api/users/:id without an email change keeps verification', async () => {
      const target = await registerVerifiedUser(app, 'same@example.com');
      await request(app.getHttpServer())
        .patch(`/api/users/${target.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: 'Same@example.com', firstName: 'Same' })
        .expect(200);
      const row = await app
        .get(PrismaService)
        .user.findUniqueOrThrow({ where: { id: target.id } });
      expect(row.emailVerifiedAt).not.toBeNull();
    });

    // Audit columns (createdBy/updatedBy/deletedBy) are intentionally
    // hidden from the API response and not in the body. Verify via the
    // DB row directly — the columns still exist for reporting.
    it('POST /api/users sets createdBy and updatedBy to the acting admin (DB-side assertion)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          email: 'audited@example.com',
          password: PASSWORD,
          firstName: 'Audited',
          lastName: 'User',
        })
        .expect(201);
      expect(res.body).not.toHaveProperty('createdBy');
      expect(res.body).not.toHaveProperty('updatedBy');

      const row = await app
        .get(PrismaService)
        .user.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row.createdBy).toBe(adminId);
      expect(row.updatedBy).toBe(adminId);
    });

    it('PATCH /api/users/:id updates updatedBy but leaves createdBy intact (DB-side assertion)', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          email: 'audit-patch@example.com',
          password: PASSWORD,
          firstName: 'Audit',
          lastName: 'Patch',
        });
      const prisma = app.get(PrismaService);
      const before = await prisma.user.findUniqueOrThrow({
        where: { id: created.body.id },
      });

      const other = await createPlatformAdmin(app, 'other-admin@example.com');
      await request(app.getHttpServer())
        .patch(`/api/users/${created.body.id}`)
        .set('Authorization', `Bearer ${other.token}`)
        .send({ firstName: 'Renamed' })
        .expect(200);

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: created.body.id },
      });
      expect(after.createdBy).toBe(before.createdBy);
      expect(after.updatedBy).toBe(other.id);
    });

    it('GET /api/users/:id returns a user', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          email: 'find@example.com',
          password: PASSWORD,
          firstName: 'Find',
          lastName: 'Me',
        });

      const res = await request(app.getHttpServer())
        .get(`/api/users/${created.body.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body.email).toBe('find@example.com');
    });

    it('GET /api/users/:id with non-existent UUID returns 404 with RESOURCE_NOT_FOUND', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/users/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
      expect(res.body.errorCode).toBe('RESOURCE_NOT_FOUND');
      expect(res.body.details).toEqual({ resource: 'User' });
    });

    it('GET /api/users/:id with invalid UUID returns 400', async () => {
      await request(app.getHttpServer())
        .get('/api/users/not-a-uuid')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('PATCH /api/users/:id updates and persists changes', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          email: 'patch@example.com',
          password: PASSWORD,
          firstName: 'Patch',
          lastName: 'Me',
        });

      const patched = await request(app.getHttpServer())
        .patch(`/api/users/${created.body.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ firstName: 'Patched', isActive: false })
        .expect(200);
      expect(patched.body).toMatchObject({
        firstName: 'Patched',
        isActive: false,
      });

      const refetched = await request(app.getHttpServer())
        .get(`/api/users/${created.body.id}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(refetched.body.firstName).toBe('Patched');
      expect(refetched.body.isActive).toBe(false);
    });

    it('PATCH /api/users/:id/password refuses admin self-target (H3)', async () => {
      await request(app.getHttpServer())
        .patch(`/api/users/${adminId}/password`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ newPassword: 'new-admin-password-1' })
        .expect(403);
    });

    it('old token is rejected after password change (H2)', async () => {
      const { token } = await registerVerifiedUser(app, 'rotate@example.com');
      await request(app.getHttpServer())
        .patch('/api/users/me/password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: PASSWORD, newPassword: 'rotated-password-1' })
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/users/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('PATCH /api/users/:id/password lets admin reset without current password', async () => {
      const target = await registerVerifiedUser(app, 'target@example.com');
      await request(app.getHttpServer())
        .patch(`/api/users/${target.id}/password`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ newPassword: 'secret1' })
        .expect(400);
      await request(app.getHttpServer())
        .patch(`/api/users/${target.id}/password`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ newPassword: 'secret12' })
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ identifier: 'target@example.com', password: 'secret12' })
        .expect(200);
    });

    it('DELETE /api/users/:id soft-deletes (row remains, admin can still see it)', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          email: 'gone@example.com',
          password: PASSWORD,
          firstName: 'Gone',
          lastName: 'Soon',
        });

      await request(app.getHttpServer())
        .delete(`/api/users/${created.body.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(204);

      // Admin can still fetch the soft-deleted row via the API — but
      // `deletedAt`/`deletedBy` are hidden from the response (frontend
      // sees only `createdAt`/`updatedAt`). Deletion metadata is
      // asserted at the DB layer; reports read from there.
      const after = await request(app.getHttpServer())
        .get(`/api/users/${created.body.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(after.body).not.toHaveProperty('deletedAt');
      expect(after.body).not.toHaveProperty('deletedBy');

      const row = await app
        .get(PrismaService)
        .user.findUniqueOrThrow({ where: { id: created.body.id } });
      expect(row.deletedAt).not.toBeNull();
      expect(row.deletedBy).toBe(adminId);

      // But the deleted user can't log in.
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ identifier: 'gone@example.com', password: PASSWORD })
        .expect(401);
    });
  });
});
