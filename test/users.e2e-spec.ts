import { INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './setup/test-app';
import { truncateAll } from './setup/db';
import {
  createPlatformAdmin,
  registerAndLogin,
  seedRbacCatalog,
} from './setup/rbac';

const PASSWORD = 'correct-horse-battery-1';

// Register, mark the row emailVerifiedAt=now directly (test shortcut —
// production flow would click the email link), then log in. Returns the
// resulting access token and the user id. Every test that needs a
// logged-in session routes through this helper so the production
// verification gate is exercised identically across the suite.
async function registerUser(
  app: INestApplication<App>,
  email = 'user@example.com',
): Promise<string> {
  const { token } = await registerAndLogin(app, email);
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
      const { token } = await registerAndLogin(app, 'me@example.com');
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
      const { token } = await registerAndLogin(app);
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
      const { id, token } = await registerAndLogin(app, 'self-del@example.com');
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
      const { id, token } = await registerAndLogin(app, 'erase@example.com');

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
      const { token } = await registerAndLogin(app, 'wrong-erase@example.com');
      await request(app.getHttpServer())
        .post('/api/users/me/gdpr-erase')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: 'definitely-not-right-1' })
        .expect(401);
    });

    it('PATCH /api/users/me/username changes username', async () => {
      const { token } = await registerAndLogin(app);
      const res = await request(app.getHttpServer())
        .patch('/api/users/me/username')
        .set('Authorization', `Bearer ${token}`)
        .send({ username: 'Handle_01' })
        .expect(200);
      expect(res.body.username).toBe('handle_01');
    });

    it('PATCH /api/users/me/username returns 409 on duplicate', async () => {
      const a = await registerAndLogin(app, 'a@example.com');
      await request(app.getHttpServer())
        .patch('/api/users/me/username')
        .set('Authorization', `Bearer ${a.token}`)
        .send({ username: 'taken' })
        .expect(200);

      const b = await registerAndLogin(app, 'b@example.com');
      await request(app.getHttpServer())
        .patch('/api/users/me/username')
        .set('Authorization', `Bearer ${b.token}`)
        .send({ username: 'taken' })
        .expect(409);
    });

    it('PATCH /api/users/me/email updates email and resets emailVerifiedAt', async () => {
      const { id, token } = await registerAndLogin(app, 'old@example.com');
      // Pre-set emailVerifiedAt so we can assert it's cleared.
      const prisma = app.get(PrismaService);
      await prisma.user.update({
        where: { id },
        data: { emailVerifiedAt: new Date() },
      });

      const res = await request(app.getHttpServer())
        .patch('/api/users/me/email')
        .set('Authorization', `Bearer ${token}`)
        .send({ newEmail: 'new@example.com', currentPassword: PASSWORD })
        .expect(200);
      expect(res.body.email).toBe('new@example.com');
      // emailVerifiedAt is hidden from the response DTO — verify the DB instead.
      expect(res.body).not.toHaveProperty('emailVerifiedAt');
      const row = await prisma.user.findUniqueOrThrow({ where: { id } });
      expect(row.emailVerifiedAt).toBeNull();
    });

    it('PATCH /api/users/me/email rejects wrong current password with 401', async () => {
      const { token } = await registerAndLogin(app);
      await request(app.getHttpServer())
        .patch('/api/users/me/email')
        .set('Authorization', `Bearer ${token}`)
        .send({
          newEmail: 'x@example.com',
          currentPassword: 'wrong-password-1',
        })
        .expect(401);
    });

    it('PATCH /api/users/me/password requires current password', async () => {
      const { token } = await registerAndLogin(app, 'pw@example.com');
      await request(app.getHttpServer())
        .patch('/api/users/me/password')
        .set('Authorization', `Bearer ${token}`)
        .send({
          currentPassword: 'wrong-password-1',
          newPassword: 'new-password-1',
        })
        .expect(401);

      await request(app.getHttpServer())
        .patch('/api/users/me/password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: PASSWORD, newPassword: 'new-password-1' })
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ identifier: 'pw@example.com', password: 'new-password-1' })
        .expect(200);
    });

    it('PATCH /api/users/me/profile-image updates the URL', async () => {
      const { token } = await registerAndLogin(app);
      const res = await request(app.getHttpServer())
        .patch('/api/users/me/profile-image')
        .set('Authorization', `Bearer ${token}`)
        .send({ profileImageUrl: 'https://cdn.example.com/me.jpg' })
        .expect(200);
      expect(res.body.profileImageUrl).toBe('https://cdn.example.com/me.jpg');
    });

    it('POST /api/users/me/request-phone-verification rejects wrong current password with 401', async () => {
      // Re-auth gate (Phase C): a stolen JWT alone must not be able to
      // redirect the user's phone number — the kickoff requires the
      // current password, mirroring the email-change request endpoint.
      const { id, token } = await registerAndLogin(
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
      const { id, token } = await registerAndLogin(app, 'phone-ok@example.com');
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
      const { id, token } = await registerAndLogin(
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

    it('POST /api/users/request-password-reset always returns 200 (no enumeration)', async () => {
      await registerAndLogin(app, 'reset@example.com');
      await request(app.getHttpServer())
        .post('/api/users/request-password-reset')
        .send({ email: 'reset@example.com' })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/users/request-password-reset')
        .send({ email: 'ghost@example.com' })
        .expect(200);
    });

    it('POST /api/users/reset-password completes the flow with a valid OTP', async () => {
      const { id } = await registerAndLogin(app, 'flow@example.com');
      const prisma = app.get(PrismaService);
      const otp = '654321';
      await prisma.user.update({
        where: { id },
        data: {
          otpHash: await bcrypt.hash(otp, 10),
          otpPurpose: 'password_reset',
          otpExpiresAt: new Date(Date.now() + 10 * 60_000),
        },
      });
      await request(app.getHttpServer())
        .post('/api/users/reset-password')
        .send({
          email: 'flow@example.com',
          otp,
          newPassword: 'brand-new-pw-1',
        })
        .expect(200);
      // Old password rejected, new password works.
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ identifier: 'flow@example.com', password: PASSWORD })
        .expect(401);
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ identifier: 'flow@example.com', password: 'brand-new-pw-1' })
        .expect(200);
    });

    it('POST /api/users/reset-password rejects wrong OTP with 400', async () => {
      const { id } = await registerAndLogin(app, 'wrong-otp@example.com');
      const prisma = app.get(PrismaService);
      await prisma.user.update({
        where: { id },
        data: {
          otpHash: await bcrypt.hash('111111', 10),
          otpPurpose: 'password_reset',
          otpExpiresAt: new Date(Date.now() + 10 * 60_000),
        },
      });
      await request(app.getHttpServer())
        .post('/api/users/reset-password')
        .send({
          email: 'wrong-otp@example.com',
          otp: '999999',
          newPassword: 'brand-new-pw-1',
        })
        .expect(400);
    });

    it('GET /api/users/me/export returns the user JSON', async () => {
      const { token } = await registerAndLogin(app, 'export@example.com');
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
      // lives in `user_roles` / `business_members`, never on the user row.
      expect(res.body.data[0]).not.toHaveProperty('role');
      expect(res.body.data[0]).not.toHaveProperty('password');
    });

    // P2002 → 409 envelope contract. Exercised here rather than through
    // /auth/register, which deliberately no longer surfaces a conflict (it
    // would let an anonymous caller enumerate registered addresses). An
    // authenticated admin, by contrast, should get the real error.
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
        .get('/api/users?perPage=9999')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('POST /api/users creates a user', async () => {
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
      const { token } = await registerAndLogin(app, 'rotate@example.com');
      // Wait past a full second boundary so passwordChangedAt lands in a
      // strictly later second than the token's iat.
      await new Promise((resolve) => setTimeout(resolve, 2000));
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
      const target = await registerAndLogin(app, 'target@example.com');
      await request(app.getHttpServer())
        .patch(`/api/users/${target.id}/password`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ newPassword: 'admin-reset-1' })
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ identifier: 'target@example.com', password: 'admin-reset-1' })
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
