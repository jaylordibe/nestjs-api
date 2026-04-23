import { INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './setup/test-app';
import { truncateAll } from './setup/db';

const PASSWORD = 'correct-horse-battery-1';

async function seedAdmin(
  app: INestApplication<App>,
): Promise<{ id: string; token: string }> {
  const prisma = app.get(PrismaService);
  const admin = await prisma.user.create({
    data: {
      email: 'admin@example.com',
      password: await bcrypt.hash(PASSWORD, 10),
      firstName: 'Admin',
      lastName: 'User',
      role: 'admin',
    },
  });
  const res = await request(app.getHttpServer())
    .post('/api/auth/login')
    .send({ email: 'admin@example.com', password: PASSWORD });
  return { id: admin.id, token: res.body.accessToken as string };
}

async function registerUser(
  app: INestApplication<App>,
  email: string,
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

describe('DeviceTokens (e2e)', () => {
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

  it('POST /api/device-tokens rejects non-admin with 403', async () => {
    const user = await registerUser(app, 'user@example.com');
    await request(app.getHttpServer())
      .post('/api/device-tokens')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        userId: user.id,
        token: 'fcm-token-1',
        appPlatform: 'mobile',
        deviceType: 'smartphone',
        deviceOs: 'ios',
        deviceOsVersion: '17.1',
      })
      .expect(403);
  });

  it('POST /api/device-tokens creates a device token (admin)', async () => {
    const admin = await seedAdmin(app);
    const user = await registerUser(app, 'owner@example.com');
    const res = await request(app.getHttpServer())
      .post('/api/device-tokens')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        userId: user.id,
        token: 'fcm-token-abc',
        appPlatform: 'mobile',
        deviceType: 'smartphone',
        deviceOs: 'android',
        deviceOsVersion: '14',
      })
      .expect(201);
    expect(res.body).toMatchObject({
      userId: user.id,
      token: 'fcm-token-abc',
      appPlatform: 'mobile',
      deviceType: 'smartphone',
      deviceOs: 'android',
      deviceOsVersion: '14',
      isActive: true,
    });
  });

  it('POST /api/device-tokens rejects invalid enum values with 400', async () => {
    const admin = await seedAdmin(app);
    const user = await registerUser(app, 'invalid@example.com');
    await request(app.getHttpServer())
      .post('/api/device-tokens')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        userId: user.id,
        token: 'tok',
        appPlatform: 'mobile',
        deviceType: 'smartphone',
        deviceOs: 'blackberry',
        deviceOsVersion: '10',
      })
      .expect(400);
  });

  it('POST /api/device-tokens rejects duplicate token with 409', async () => {
    const admin = await seedAdmin(app);
    const user = await registerUser(app, 'dup@example.com');
    const payload = {
      userId: user.id,
      token: 'duplicate-token',
      appPlatform: 'web',
      deviceType: 'laptop',
      deviceOs: 'macos',
      deviceOsVersion: 'Sonoma 14.2',
    };
    await request(app.getHttpServer())
      .post('/api/device-tokens')
      .set('Authorization', `Bearer ${admin.token}`)
      .send(payload)
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/device-tokens')
      .set('Authorization', `Bearer ${admin.token}`)
      .send(payload)
      .expect(409);
  });

  it('POST /api/device-tokens rejects dangling userId with 400 (FK)', async () => {
    const admin = await seedAdmin(app);
    await request(app.getHttpServer())
      .post('/api/device-tokens')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        userId: '00000000-0000-0000-0000-000000000000',
        token: 'orphan',
        appPlatform: 'mobile',
        deviceType: 'smartphone',
        deviceOs: 'ios',
        deviceOsVersion: '17',
      })
      .expect(400);
  });

  it('GET /api/device-tokens is paginated (admin)', async () => {
    const admin = await seedAdmin(app);
    const user = await registerUser(app, 'list@example.com');
    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer())
        .post('/api/device-tokens')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({
          userId: user.id,
          token: `tok-${i}`,
          appPlatform: 'mobile',
          deviceType: 'smartphone',
          deviceOs: 'ios',
          deviceOsVersion: '17',
        })
        .expect(201);
    }
    const res = await request(app.getHttpServer())
      .get('/api/device-tokens?perPage=2')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(res.body.meta).toMatchObject({
      page: 1,
      perPage: 2,
      total: 3,
      totalPages: 2,
    });
    expect(res.body.data).toHaveLength(2);
  });

  it('PATCH /api/device-tokens/:id updates fields (admin)', async () => {
    const admin = await seedAdmin(app);
    const user = await registerUser(app, 'patch@example.com');
    const created = await request(app.getHttpServer())
      .post('/api/device-tokens')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        userId: user.id,
        token: 'patch-tok',
        appPlatform: 'mobile',
        deviceType: 'smartphone',
        deviceOs: 'ios',
        deviceOsVersion: '17.0',
      });

    const res = await request(app.getHttpServer())
      .patch(`/api/device-tokens/${created.body.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ deviceOsVersion: '17.4', isActive: false })
      .expect(200);
    expect(res.body.deviceOsVersion).toBe('17.4');
    expect(res.body.isActive).toBe(false);
  });

  it('DELETE /api/device-tokens/:id removes the row (admin)', async () => {
    const admin = await seedAdmin(app);
    const user = await registerUser(app, 'delete@example.com');
    const created = await request(app.getHttpServer())
      .post('/api/device-tokens')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        userId: user.id,
        token: 'delete-tok',
        appPlatform: 'desktop',
        deviceType: 'desktop',
        deviceOs: 'linux',
        deviceOsVersion: 'Ubuntu 24.04',
      });

    await request(app.getHttpServer())
      .delete(`/api/device-tokens/${created.body.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(204);

    await request(app.getHttpServer())
      .get(`/api/device-tokens/${created.body.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(404);
  });

  it('cascades: hard-deleting a user at the DB level removes their device tokens', async () => {
    // Admin DELETE is soft (sets deletedAt), so the FK cascade doesn't
    // fire through the API. This test verifies the cascade is still wired
    // correctly at the DB level — it'll matter for any retention job that
    // eventually hard-deletes long-soft-deleted users.
    const admin = await seedAdmin(app);
    const user = await registerUser(app, 'cascade@example.com');
    const prisma = app.get(PrismaService);
    await request(app.getHttpServer())
      .post('/api/device-tokens')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        userId: user.id,
        token: 'cascade-tok',
        appPlatform: 'mobile',
        deviceType: 'smartphone',
        deviceOs: 'ios',
        deviceOsVersion: '17',
      })
      .expect(201);
    expect(await prisma.deviceToken.count({ where: { userId: user.id } })).toBe(
      1,
    );

    await prisma.user.delete({ where: { id: user.id } });

    expect(await prisma.deviceToken.count({ where: { userId: user.id } })).toBe(
      0,
    );
  });
});
