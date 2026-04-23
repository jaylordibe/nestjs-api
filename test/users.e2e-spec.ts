import { INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './setup/test-app';
import { truncateAll } from './setup/db';

const PASSWORD = 'correct-horse-battery';

async function loginAs(
  app: INestApplication<App>,
  email: string,
  password: string,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/login')
    .send({ email, password });
  return res.body.accessToken as string;
}

async function seedAdmin(
  app: INestApplication<App>,
  email = 'admin@example.com',
): Promise<{ id: string; token: string }> {
  const prisma = app.get(PrismaService);
  const admin = await prisma.user.create({
    data: {
      email,
      password: await bcrypt.hash(PASSWORD, 10),
      firstName: 'Admin',
      lastName: 'User',
      role: 'admin',
    },
  });
  const token = await loginAs(app, email, PASSWORD);
  return { id: admin.id, token };
}

async function registerUser(
  app: INestApplication<App>,
  email = 'user@example.com',
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/register')
    .send({
      email,
      password: PASSWORD,
      firstName: 'Regular',
      lastName: 'User',
    });
  return res.body.accessToken as string;
}

async function registerAndToken(
  app: INestApplication<App>,
  email = 'user@example.com',
): Promise<{ id: string; token: string }> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/register')
    .send({
      email,
      password: PASSWORD,
      firstName: 'Regular',
      lastName: 'User',
    });
  return { id: res.body.user.id, token: res.body.accessToken };
}

describe('Users (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll(app);
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

  describe('sign-up and self-service', () => {
    it('POST /api/users/sign-up creates a user and returns a token', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/users/sign-up')
        .send({
          email: 'newbie@example.com',
          password: PASSWORD,
          firstName: 'New',
          lastName: 'Bie',
        })
        .expect(201);
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.user.email).toBe('newbie@example.com');
      expect(res.body.user.role).toBe('user');
    });

    it('GET /api/users/me returns the authenticated user', async () => {
      const { token } = await registerAndToken(app, 'me@example.com');
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
      const { token } = await registerAndToken(app);
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

    it('DELETE /api/users/me soft-deletes (isActive=false)', async () => {
      const { id, token } = await registerAndToken(app);
      await request(app.getHttpServer())
        .delete('/api/users/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      const prisma = app.get(PrismaService);
      const row = await prisma.user.findUniqueOrThrow({ where: { id } });
      expect(row.isActive).toBe(false);
    });

    it('PATCH /api/users/me/username changes username', async () => {
      const { token } = await registerAndToken(app);
      const res = await request(app.getHttpServer())
        .patch('/api/users/me/username')
        .set('Authorization', `Bearer ${token}`)
        .send({ username: 'Handle_01' })
        .expect(200);
      expect(res.body.username).toBe('handle_01');
    });

    it('PATCH /api/users/me/username returns 409 on duplicate', async () => {
      const a = await registerAndToken(app, 'a@example.com');
      await request(app.getHttpServer())
        .patch('/api/users/me/username')
        .set('Authorization', `Bearer ${a.token}`)
        .send({ username: 'taken' })
        .expect(200);

      const b = await registerAndToken(app, 'b@example.com');
      await request(app.getHttpServer())
        .patch('/api/users/me/username')
        .set('Authorization', `Bearer ${b.token}`)
        .send({ username: 'taken' })
        .expect(409);
    });

    it('PATCH /api/users/me/email updates email and resets emailVerifiedAt', async () => {
      const { id, token } = await registerAndToken(app, 'old@example.com');
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
      expect(res.body.emailVerifiedAt).toBeNull();
    });

    it('PATCH /api/users/me/email rejects wrong current password with 401', async () => {
      const { token } = await registerAndToken(app);
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
      const { token } = await registerAndToken(app, 'pw@example.com');
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
        .send({ email: 'pw@example.com', password: 'new-password-1' })
        .expect(200);
    });

    it('PATCH /api/users/me/profile-image updates the URL', async () => {
      const { token } = await registerAndToken(app);
      const res = await request(app.getHttpServer())
        .patch('/api/users/me/profile-image')
        .set('Authorization', `Bearer ${token}`)
        .send({ profileImageUrl: 'https://cdn.example.com/me.jpg' })
        .expect(200);
      expect(res.body.profileImageUrl).toBe('https://cdn.example.com/me.jpg');
    });

    it('POST /api/users/verify-email returns 400 when no OTP is in progress', async () => {
      const { token } = await registerAndToken(app);
      await request(app.getHttpServer())
        .post('/api/users/verify-email')
        .set('Authorization', `Bearer ${token}`)
        .send({ otp: '123456' })
        .expect(400);
    });

    it('POST /api/users/verify-email succeeds when OTP matches', async () => {
      const { id, token } = await registerAndToken(app, 'verify@example.com');
      const prisma = app.get(PrismaService);
      const otp = '123456';
      await prisma.user.update({
        where: { id },
        data: {
          otpHash: await bcrypt.hash(otp, 10),
          otpPurpose: 'email_verify',
          otpExpiresAt: new Date(Date.now() + 10 * 60_000),
        },
      });

      const res = await request(app.getHttpServer())
        .post('/api/users/verify-email')
        .set('Authorization', `Bearer ${token}`)
        .send({ otp })
        .expect(200);
      expect(res.body.emailVerifiedAt).not.toBeNull();

      const row = await prisma.user.findUniqueOrThrow({ where: { id } });
      expect(row.otpHash).toBeNull();
      expect(row.otpPurpose).toBeNull();
      expect(row.otpExpiresAt).toBeNull();
    });
  });

  describe('as ADMIN', () => {
    let adminToken: string;
    let adminId: string;

    beforeEach(async () => {
      ({ id: adminId, token: adminToken } = await seedAdmin(app));
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
        role: 'admin',
      });
      expect(res.body.data[0]).not.toHaveProperty('password');
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

    it('GET /api/users/all returns the full unpaginated list', async () => {
      await request(app.getHttpServer())
        .post('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          email: 'second@example.com',
          password: PASSWORD,
          firstName: 'Second',
          lastName: 'User',
        });

      const res = await request(app.getHttpServer())
        .get('/api/users/all')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
      expect(res.body[0]).not.toHaveProperty('password');
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
          role: 'user',
        })
        .expect(201);
      expect(res.body).toMatchObject({
        email: 'new@example.com',
        role: 'user',
        isActive: true,
      });
      expect(res.body).not.toHaveProperty('password');
    });

    it('POST /api/users sets createdBy and updatedBy to the acting admin', async () => {
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
      expect(res.body.createdBy).toBe(adminId);
      expect(res.body.updatedBy).toBe(adminId);
    });

    it('PATCH /api/users/:id updates updatedBy but leaves createdBy intact', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          email: 'audit-patch@example.com',
          password: PASSWORD,
          firstName: 'Audit',
          lastName: 'Patch',
        });
      const createdBy = created.body.createdBy;

      const other = await seedAdmin(app, 'other-admin@example.com');
      const patched = await request(app.getHttpServer())
        .patch(`/api/users/${created.body.id}`)
        .set('Authorization', `Bearer ${other.token}`)
        .send({ firstName: 'Renamed' })
        .expect(200);
      expect(patched.body.createdBy).toBe(createdBy);
      expect(patched.body.updatedBy).toBe(other.id);
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

    it('GET /api/users/:id with non-existent UUID returns 404', async () => {
      await request(app.getHttpServer())
        .get('/api/users/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
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

    it('PATCH /api/users/:id/password lets admin reset without current password', async () => {
      const target = await registerAndToken(app, 'target@example.com');
      await request(app.getHttpServer())
        .patch(`/api/users/${target.id}/password`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ newPassword: 'admin-reset-1' })
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'target@example.com', password: 'admin-reset-1' })
        .expect(200);
    });

    it('DELETE /api/users/:id removes the user', async () => {
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

      await request(app.getHttpServer())
        .get(`/api/users/${created.body.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });
  });
});
