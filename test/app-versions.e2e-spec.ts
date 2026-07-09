import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './setup/test-app';
import { truncateAll } from './setup/db';
import {
  createPlatformAdmin,
  createRegularUser,
  seedRbacCatalog,
} from './setup/rbac';

describe('AppVersions (e2e)', () => {
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

  it('POST /api/app-versions rejects non-admin with 403', async () => {
    const userToken = (await createRegularUser(app)).token;
    await request(app.getHttpServer())
      .post('/api/app-versions')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        version: '1.0.0',
        platform: 'mobile',
        releaseDate: new Date().toISOString(),
      })
      .expect(403);
  });

  it('POST /api/app-versions creates an app version (admin)', async () => {
    const { token } = await createPlatformAdmin(app);
    const res = await request(app.getHttpServer())
      .post('/api/app-versions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        version: '1.2.3',
        description: 'Initial release',
        platform: 'mobile',
        releaseDate: '2026-04-20T00:00:00.000Z',
        downloadUrl: 'https://apps.example.com/1.2.3.apk',
        forceUpdate: true,
      })
      .expect(201);
    expect(res.body).toMatchObject({
      version: '1.2.3',
      description: 'Initial release',
      platform: 'mobile',
      downloadUrl: 'https://apps.example.com/1.2.3.apk',
      forceUpdate: true,
    });
    // createdBy is scrubbed from the API response; verify it was
    // populated at the DB level.
    expect(res.body).not.toHaveProperty('createdBy');
    const row = await app
      .get(PrismaService)
      .appVersion.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.createdBy).not.toBeNull();
  });

  it('POST /api/app-versions rejects invalid platform with 400', async () => {
    const { token } = await createPlatformAdmin(app);
    await request(app.getHttpServer())
      .post('/api/app-versions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        version: '1.0.0',
        platform: 'console',
        releaseDate: new Date().toISOString(),
      })
      .expect(400);
  });

  it('POST /api/app-versions rejects duplicate platform+version with 409', async () => {
    const { token } = await createPlatformAdmin(app);
    const payload = {
      version: '1.0.0',
      platform: 'web',
      releaseDate: '2026-04-20T00:00:00.000Z',
    };
    await request(app.getHttpServer())
      .post('/api/app-versions')
      .set('Authorization', `Bearer ${token}`)
      .send(payload)
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/app-versions')
      .set('Authorization', `Bearer ${token}`)
      .send(payload)
      .expect(409);
  });

  it('GET /api/app-versions is public and paginated', async () => {
    const { token } = await createPlatformAdmin(app);
    await request(app.getHttpServer())
      .post('/api/app-versions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        version: '1.0.0',
        platform: 'web',
        releaseDate: '2026-04-01T00:00:00.000Z',
      })
      .expect(201);

    // No Authorization header.
    const res = await request(app.getHttpServer())
      .get('/api/app-versions')
      .expect(200);
    expect(res.body.meta).toMatchObject({ page: 1, perPage: 20, total: 1 });
    expect(res.body.data).toHaveLength(1);
  });

  it('PATCH /api/app-versions/:id updates fields (admin)', async () => {
    const { token } = await createPlatformAdmin(app);
    const created = await request(app.getHttpServer())
      .post('/api/app-versions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        version: '2.0.0',
        platform: 'mobile',
        releaseDate: '2026-04-20T00:00:00.000Z',
        forceUpdate: false,
      });

    const res = await request(app.getHttpServer())
      .patch(`/api/app-versions/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ forceUpdate: true, description: 'Critical security fix' })
      .expect(200);
    expect(res.body.forceUpdate).toBe(true);
    expect(res.body.description).toBe('Critical security fix');
  });

  it('GET /api/app-versions/latest returns the newest active version for a platform', async () => {
    const { token } = await createPlatformAdmin(app);
    // Older mobile release
    await request(app.getHttpServer())
      .post('/api/app-versions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        version: '1.0.0',
        platform: 'mobile',
        releaseDate: '2026-01-01T00:00:00.000Z',
      })
      .expect(201);
    // Newer mobile release
    await request(app.getHttpServer())
      .post('/api/app-versions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        version: '2.0.0',
        platform: 'mobile',
        releaseDate: '2026-04-01T00:00:00.000Z',
        forceUpdate: true,
      })
      .expect(201);
    // Different platform — should be ignored by the query
    await request(app.getHttpServer())
      .post('/api/app-versions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        version: '9.9.9',
        platform: 'web',
        releaseDate: '2026-05-01T00:00:00.000Z',
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/api/app-versions/latest?platform=mobile')
      .expect(200);
    expect(res.body.version).toBe('2.0.0');
    expect(res.body.platform).toBe('mobile');
    expect(res.body.forceUpdate).toBe(true);
  });

  it('GET /api/app-versions/latest falls back to the next-newest after a bad release is deleted', async () => {
    // This table is a signal, not history: a bad release gets deleted
    // rather than deactivated. `latest` reads the newest remaining row.
    const { token } = await createPlatformAdmin(app);
    const newer = await request(app.getHttpServer())
      .post('/api/app-versions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        version: '3.0.0',
        platform: 'desktop',
        releaseDate: '2026-04-01T00:00:00.000Z',
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/app-versions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        version: '2.0.0',
        platform: 'desktop',
        releaseDate: '2026-03-01T00:00:00.000Z',
      })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/api/app-versions/${newer.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    const res = await request(app.getHttpServer())
      .get('/api/app-versions/latest?platform=desktop')
      .expect(200);
    expect(res.body.version).toBe('2.0.0');
  });

  it('GET /api/app-versions/latest returns 404 when no version exists', async () => {
    await request(app.getHttpServer())
      .get('/api/app-versions/latest?platform=web')
      .expect(404);
  });

  it('GET /api/app-versions/latest rejects invalid platform with 400', async () => {
    await request(app.getHttpServer())
      .get('/api/app-versions/latest?platform=console')
      .expect(400);
  });

  it('DELETE /api/app-versions/:id removes the row (admin)', async () => {
    const { token } = await createPlatformAdmin(app);
    const created = await request(app.getHttpServer())
      .post('/api/app-versions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        version: '3.0.0',
        platform: 'desktop',
        releaseDate: '2026-04-20T00:00:00.000Z',
      });

    await request(app.getHttpServer())
      .delete(`/api/app-versions/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    await request(app.getHttpServer())
      .get(`/api/app-versions/${created.body.id}`)
      .expect(404);
  });
});
