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
): Promise<string> {
  const prisma = app.get(PrismaService);
  await prisma.user.create({
    data: {
      email,
      password: await bcrypt.hash(PASSWORD, 10),
      firstName: 'Admin',
      lastName: 'User',
      role: 'ADMIN',
    },
  });
  return loginAs(app, email, PASSWORD);
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

    beforeEach(async () => {
      adminToken = await seedAdmin(app);
    });

    it('GET /api/users returns the list', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({
        email: 'admin@example.com',
        role: 'ADMIN',
      });
      expect(res.body[0]).not.toHaveProperty('password');
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
          role: 'USER',
        })
        .expect(201);
      expect(res.body).toMatchObject({
        email: 'new@example.com',
        role: 'USER',
        isActive: true,
      });
      expect(res.body).not.toHaveProperty('password');
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
