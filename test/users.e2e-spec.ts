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
