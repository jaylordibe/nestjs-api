import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { NotificationsQueueProcessor } from '../src/common/queue/processors/notifications-queue.processor';
import { JobOutcomeStatus } from '../src/common/queue/queue-job-outcome';
import { QueueName } from '../src/common/queue/queue-registry';
import { RedisService } from '../src/common/redis/redis.service';
import { DestinationSendLimitService } from '../src/common/send-limit/destination-send-limit.service';
import {
  SEND_LIMITS,
  SendPurpose,
} from '../src/common/send-limit/send-limit.config';
import { SmsService } from '../src/common/sms/sms.service';
import { SeededRoleName } from '../src/common/enums/seeded-role-name.enum';
import { PrismaService } from '../src/prisma/prisma.service';
import { truncateAll } from './setup/db';
import {
  captureEmails,
  deliverQueuedEmails,
  linkParameter,
} from './setup/emails';
import {
  createWorkspaceWithOwner,
  registerVerifiedUser,
  roleIdFor,
  seedRbacCatalog,
  TEST_PASSWORD,
} from './setup/rbac';
import { createTestApp } from './setup/test-app';

// One destination — an inbox or a phone number — receives a capped number of
// messages per purpose per window, however many accounts or addresses ask.
//
// Three properties matter as much as the cap itself, and each has a test:
//   • a refused send answers EXACTLY like a sent one (no enumeration, no
//     cross-user oracle);
//   • a refused send mints nothing, so the code or link the person already
//     received keeps working (the cap must not become a lockout);
//   • the password-changed alert is never capped.
//
// Throttling is off under NODE_ENV=test, so the per-route limits never
// interfere; the counters live in this worker's Redis database, which
// `truncateAll` flushes between tests.

const PHONE_NUMBER = '+14155550199';

describe('Destination send limit (e2e)', () => {
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

  // The stub adapter does not surface the code, so record each send.
  function recordSms() {
    const sent: Array<{ phoneNumber: string; otp: string }> = [];
    const spy = jest
      .spyOn(app.get(SmsService), 'sendPhoneVerificationOtp')
      .mockImplementation((phoneNumber, otp) => {
        sent.push({ phoneNumber, otp });
        return Promise.resolve();
      });
    return { sent, restore: () => spy.mockRestore() };
  }

  const requestPhoneVerification = (token: string) =>
    request(app.getHttpServer())
      .post('/api/users/me/request-phone-verification')
      .set('Authorization', `Bearer ${token}`)
      .send({ phoneNumber: PHONE_NUMBER, currentPassword: TEST_PASSWORD });

  const otpHashOf = async (userId: string) =>
    (
      await app
        .get(PrismaService)
        .user.findUniqueOrThrow({ where: { id: userId } })
    ).otpHash;

  describe('SMS', () => {
    it('caps one number across accounts, answers as usual, and keeps the last code valid', async () => {
      const first = await registerVerifiedUser(app, 'first@example.com');
      const second = await registerVerifiedUser(app, 'second@example.com');
      const { limit } = SEND_LIMITS[SendPurpose.PHONE_VERIFICATION];
      const sms = recordSms();
      try {
        // Spread the budget over two accounts: the cap is the number's, not
        // either account's.
        for (let send = 0; send < limit - 1; send++) {
          await requestPhoneVerification(first.token).expect(200);
        }
        const lastAllowed = await requestPhoneVerification(second.token)
          .expect(200)
          .then((response) => response.body as unknown);
        const hashBeforeRefusal = await otpHashOf(second.id);

        const refused = await requestPhoneVerification(second.token).expect(
          200,
        );

        expect(refused.body).toEqual(lastAllowed);
        expect(sms.sent).toHaveLength(limit);
        // Nothing was minted, so the code already delivered still verifies.
        expect(await otpHashOf(second.id)).toBe(hashBeforeRefusal);
        await request(app.getHttpServer())
          .patch('/api/users/me/verify-phone')
          .set('Authorization', `Bearer ${second.token}`)
          .send({ phoneNumber: PHONE_NUMBER, otp: sms.sent.at(-1)!.otp })
          .expect(200);
      } finally {
        sms.restore();
      }
    });

    // Parallel requests must not each read "under the limit".
    it('holds the cap under concurrent requests', async () => {
      const user = await registerVerifiedUser(app, 'parallel@example.com');
      const { limit } = SEND_LIMITS[SendPurpose.PHONE_VERIFICATION];
      const sms = recordSms();
      try {
        await Promise.all(
          Array.from({ length: limit + 3 }, () =>
            requestPhoneVerification(user.token).expect(200),
          ),
        );

        expect(sms.sent).toHaveLength(limit);
      } finally {
        sms.restore();
      }
    });

    // A provider outage must not use up the number's budget.
    it('gives the budget back when the SMS provider fails', async () => {
      const user = await registerVerifiedUser(app, 'provider@example.com');
      const { limit } = SEND_LIMITS[SendPurpose.PHONE_VERIFICATION];
      const failing = jest
        .spyOn(app.get(SmsService), 'sendPhoneVerificationOtp')
        .mockRejectedValue(new Error('provider down'));
      try {
        for (let attempt = 0; attempt <= limit; attempt++) {
          await requestPhoneVerification(user.token).expect(500);
        }
      } finally {
        failing.mockRestore();
      }
      const sms = recordSms();
      try {
        await requestPhoneVerification(user.token).expect(200);

        expect(sms.sent).toHaveLength(1);
      } finally {
        sms.restore();
      }
    });
  });

  describe('password reset', () => {
    const requestReset = (email: string) =>
      request(app.getHttpServer())
        .post('/api/users/request-password-reset')
        .send({ email })
        .expect(200);

    it('caps one inbox, mints nothing when refused, and the last link still works', async () => {
      const user = await registerVerifiedUser(app, 'reset@example.com');
      await deliverQueuedEmails(app);
      const { limit } = SEND_LIMITS[SendPurpose.PASSWORD_RESET];
      const emails = captureEmails(app);
      try {
        for (let send = 0; send < limit; send++) {
          await requestReset(user.email);
          await deliverQueuedEmails(app);
        }
        const hashBeforeRefusal = await otpHashOf(user.id);

        await requestReset(user.email);
        // Through the real processor, so the recorded outcome is asserted:
        // skipped with its own reason, never failed (which would retry).
        const queue = app.get<Queue>(getQueueToken(QueueName.NOTIFICATIONS));
        const [refusedJob] = await queue.getJobs(['waiting'], 0, -1, true);
        const outcome = await app
          .get(NotificationsQueueProcessor)
          .process(refusedJob!);
        await refusedJob!.remove();

        expect(outcome).toEqual({
          status: JobOutcomeStatus.SKIPPED,
          reason: 'destination limit reached',
        });
        expect(emails.sent).toHaveLength(limit);
        expect(await otpHashOf(user.id)).toBe(hashBeforeRefusal);
        await request(app.getHttpServer())
          .post('/api/users/reset-password')
          .send({
            email: user.email,
            token: linkParameter(emails.sent.at(-1)!, 'resetUrl', 'token'),
            newPassword: 'brand-new-pw-1',
          })
          .expect(200);
        // On real Redis the window really expires, and nothing else sits in
        // the key but an HMAC.
        const redis = app.get(RedisService).client;
        const keys = await redis.keys('send-limit:password-reset:*');
        expect(keys).toHaveLength(1);
        expect(keys[0]).toMatch(/^send-limit:password-reset:[0-9a-f]{64}$/);
        const ttl = await redis.ttl(keys[0]!);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(
          SEND_LIMITS[SendPurpose.PASSWORD_RESET].windowSeconds,
        );
      } finally {
        emails.restore();
      }
    });

    // Gmail ignores dots and `+tag`, so these two accounts share one inbox —
    // and must share one budget, or each spelling would get its own.
    it('counts every spelling of one inbox against the same budget', async () => {
      await registerVerifiedUser(app, 'victim+one@gmail.com');
      await registerVerifiedUser(app, 'vic.tim@gmail.com');
      await deliverQueuedEmails(app);
      const { limit } = SEND_LIMITS[SendPurpose.PASSWORD_RESET];
      const emails = captureEmails(app);
      try {
        for (let send = 0; send <= limit; send++) {
          await requestReset(
            send % 2 === 0 ? 'victim+one@gmail.com' : 'vic.tim@gmail.com',
          );
          await deliverQueuedEmails(app);
        }

        expect(emails.sent).toHaveLength(limit);
      } finally {
        emails.restore();
      }
    });
  });

  describe('password-changed notice', () => {
    // Each change signs the caller in afresh; the old token is invalidated.
    async function changePassword(
      token: string,
      currentPassword: string,
      newPassword: string,
    ): Promise<string> {
      const response = await request(app.getHttpServer())
        .patch('/api/users/me/password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword, newPassword })
        .expect(200);
      return response.body.accessToken as string;
    }

    async function changePasswordRepeatedly(
      token: string,
      times: number,
    ): Promise<void> {
      const passwords = [TEST_PASSWORD, 'another-new-pw-1'];
      let current = token;
      for (let change = 0; change < times; change++) {
        current = await changePassword(
          current,
          passwords[change % 2]!,
          passwords[(change + 1) % 2]!,
        );
      }
    }

    // The alert an account takeover would most like to suppress.
    it('is never capped for a verified address', async () => {
      const user = await registerVerifiedUser(app, 'notice@example.com');
      await deliverQueuedEmails(app);
      const { limit } =
        SEND_LIMITS[SendPurpose.UNVERIFIED_PASSWORD_CHANGED_NOTICE];
      const emails = captureEmails(app);
      try {
        await changePasswordRepeatedly(user.token, limit + 1);
        await deliverQueuedEmails(app);

        expect(emails.sent.map((email) => email.template)).toEqual(
          Array(limit + 1).fill('password-changed-notification'),
        );
      } finally {
        emails.restore();
      }
    });

    // Pointing one's own account at a victim's inbox (stored unverified) and
    // changing one's own password must not become a way to flood that inbox.
    it('is capped for an address that is not verified', async () => {
      const attacker = await registerVerifiedUser(app, 'attacker@example.com');
      const moved = await request(app.getHttpServer())
        .patch('/api/users/me/email')
        .set('Authorization', `Bearer ${attacker.token}`)
        .send({
          newEmail: 'victim@example.com',
          currentPassword: TEST_PASSWORD,
        })
        .expect(200);
      await deliverQueuedEmails(app);
      const { limit } =
        SEND_LIMITS[SendPurpose.UNVERIFIED_PASSWORD_CHANGED_NOTICE];
      const emails = captureEmails(app);
      try {
        await changePasswordRepeatedly(
          moved.body.accessToken as string,
          limit + 2,
        );
        await deliverQueuedEmails(app);

        expect(
          emails.sent.filter(
            (email) => email.template === 'password-changed-notification',
          ),
        ).toHaveLength(limit);
      } finally {
        emails.restore();
      }
    });
  });

  describe('email verification', () => {
    const resendVerification = (email: string) =>
      request(app.getHttpServer())
        .post('/api/auth/resend-verification')
        .send({ email })
        .expect(200);

    // The public route promises the same answer for every address. A capped
    // address must not become the one that answers differently.
    it('answers a capped address exactly like an unregistered one', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          email: 'unverified@example.com',
          password: TEST_PASSWORD,
          firstName: 'Un',
          lastName: 'Verified',
        })
        .expect(201);
      const { limit } = SEND_LIMITS[SendPurpose.EMAIL_VERIFICATION];
      const emails = captureEmails(app);
      try {
        await deliverQueuedEmails(app);
        for (let send = 1; send < limit; send++) {
          await resendVerification('unverified@example.com');
          await deliverQueuedEmails(app);
        }
        expect(emails.sent).toHaveLength(limit);

        const capped = await resendVerification('unverified@example.com');
        const unregistered = await resendVerification('ghost@example.com');
        await deliverQueuedEmails(app);

        expect(capped.body).toEqual(unregistered.body);
        expect(emails.sent).toHaveLength(limit);
      } finally {
        emails.restore();
      }
    });
  });

  describe('workspace invitations', () => {
    it('caps one inbox invited from many workspaces', async () => {
      const owner = await registerVerifiedUser(app, 'owner@example.com');
      await deliverQueuedEmails(app);
      const roleId = await roleIdFor(app, SeededRoleName.WORKSPACE_MEMBER);
      const { limit } = SEND_LIMITS[SendPurpose.WORKSPACE_INVITATION];
      const emails = captureEmails(app);
      try {
        // All workspaces first: the fixture writes memberships straight to
        // the database, so the owner's grants — cached on their first
        // request — must already include every one of them.
        const workspaceIds: string[] = [];
        for (let workspace = 0; workspace <= limit; workspace++) {
          const { id } = await createWorkspaceWithOwner(
            app,
            owner.id,
            `workspace-${workspace}`,
          );
          workspaceIds.push(id);
        }
        // Spellings of one Gmail inbox: one budget between them.
        for (const [index, workspaceId] of workspaceIds.entries()) {
          await request(app.getHttpServer())
            .post(`/api/workspaces/${workspaceId}/invitations`)
            .set('Authorization', `Bearer ${owner.token}`)
            .send({
              email:
                index % 2 === 0 ? 'invitee+a@gmail.com' : 'in.vitee@gmail.com',
              roleId,
            })
            .expect(201);
        }
        await deliverQueuedEmails(app);

        expect(emails.sent).toHaveLength(limit);
      } finally {
        emails.restore();
      }
    });

    // Rotating the token kills the invitee's working link, so a resend whose
    // email would be refused must not rotate it.
    it('leaves the current link alone when a resend would be refused', async () => {
      const owner = await registerVerifiedUser(app, 'resender@example.com');
      await deliverQueuedEmails(app);
      const roleId = await roleIdFor(app, SeededRoleName.WORKSPACE_MEMBER);
      const { limit } = SEND_LIMITS[SendPurpose.WORKSPACE_INVITATION];
      const workspaceIds: string[] = [];
      for (let workspace = 0; workspace < limit; workspace++) {
        const { id } = await createWorkspaceWithOwner(
          app,
          owner.id,
          `resend-${workspace}`,
        );
        workspaceIds.push(id);
      }
      const invitationIds: string[] = [];
      for (const workspaceId of workspaceIds) {
        const created = await request(app.getHttpServer())
          .post(`/api/workspaces/${workspaceId}/invitations`)
          .set('Authorization', `Bearer ${owner.token}`)
          .send({ email: 'held@example.com', roleId })
          .expect(201);
        invitationIds.push(created.body.id as string);
      }
      await deliverQueuedEmails(app);
      const prisma = app.get(PrismaService);
      const before = await prisma.workspaceInvitation.findUniqueOrThrow({
        where: { id: invitationIds[0]! },
      });

      await request(app.getHttpServer())
        .post(
          `/api/workspaces/${workspaceIds[0]!}/invitations/${invitationIds[0]!}/resend`,
        )
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      const after = await prisma.workspaceInvitation.findUniqueOrThrow({
        where: { id: invitationIds[0]! },
      });
      expect(after.tokenHash).toBe(before.tokenHash);
    });
  });

  // The release script itself, on real Redis: giving back a unit after the
  // window expired must not recreate the counter (at -1, with no expiry).
  it('does not recreate an expired counter when a failed send is released', async () => {
    const limiter = app.get(DestinationSendLimitService);
    const redis = app.get(RedisService).client;
    const reservation = await limiter.reserve(
      SendPurpose.PASSWORD_RESET,
      'expired@example.com',
    );
    await redis.del(reservation!.key);

    await expect(
      limiter.sendReserved(reservation!, () =>
        Promise.reject(new Error('provider down')),
      ),
    ).rejects.toThrow('provider down');

    expect(await redis.exists(reservation!.key)).toBe(0);
  });
});

// A Redis outage must not turn into unlimited SMS spend: no counter, no SMS.
describe('Destination send limit — Redis unavailable (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(DestinationSendLimitService).useValue({
        reserve: () => Promise.reject(new Error('Connection is closed.')),
        sendReserved: () => Promise.reject(new Error('unreachable')),
        sendWithinLimit: () =>
          Promise.reject(new Error('Connection is closed.')),
      }),
    );
  });

  beforeEach(async () => {
    await truncateAll(app);
    await seedRbacCatalog(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses the SMS with 503 and mints no code', async () => {
    const user = await registerVerifiedUser(app, 'outage@example.com');
    const sendSpy = jest.spyOn(app.get(SmsService), 'sendPhoneVerificationOtp');
    try {
      const response = await request(app.getHttpServer())
        .post('/api/users/me/request-phone-verification')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ phoneNumber: PHONE_NUMBER, currentPassword: TEST_PASSWORD })
        .expect(503);

      expect(response.body.errorCode).toBe('EXTERNAL_SERVICE_UNAVAILABLE');
      expect(sendSpy).not.toHaveBeenCalled();
      const row = await app
        .get(PrismaService)
        .user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row.otpHash).toBeNull();
    } finally {
      sendSpy.mockRestore();
    }
  });
});
