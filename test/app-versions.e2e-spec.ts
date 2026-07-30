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

// `deviceOs` is the release train: `mobile` and `desktop` ship one build per
// OS, `web` ships one build for everyone. See
// src/modules/app-versions/release-train-registry.ts.
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
        deviceOs: 'ios',
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
        deviceOs: 'android',
        releaseDate: '2026-04-20T00:00:00.000Z',
        downloadUrl: 'https://apps.example.com/1.2.3.apk',
        forceUpdate: true,
      })
      .expect(201);
    expect(res.body).toMatchObject({
      version: '1.2.3',
      description: 'Initial release',
      platform: 'mobile',
      deviceOs: 'android',
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

  describe('release trains', () => {
    it('requires deviceOs on a platform that ships one build per OS', async () => {
      const { token } = await createPlatformAdmin(app);
      for (const platform of ['mobile', 'desktop']) {
        await request(app.getHttpServer())
          .post('/api/app-versions')
          .set('Authorization', `Bearer ${token}`)
          .send({
            version: '1.0.0',
            platform,
            releaseDate: '2026-04-20T00:00:00.000Z',
          })
          .expect(400);
      }
    });

    // The case a bare `@IsEnum(DeviceOs)` would wave through: `windows` is a
    // real DeviceOs, just not one mobile ships on. Storing it would create a
    // row no client ever matches, behind a successful 201.
    it('rejects an OS that is not a train for that platform', async () => {
      const { token } = await createPlatformAdmin(app);
      const res = await request(app.getHttpServer())
        .post('/api/app-versions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          version: '1.0.0',
          platform: 'mobile',
          deviceOs: 'windows',
          releaseDate: '2026-04-20T00:00:00.000Z',
        })
        .expect(400);
      expect(res.body.message).toContain('not a release train');
    });

    // Normalized rather than rejected: a stray value on a single-distribution
    // platform is harmless, and nulling it keeps the row matchable by the
    // `web` clients that will look for it.
    it('normalizes a stray deviceOs to null for web', async () => {
      const { token } = await createPlatformAdmin(app);
      const res = await request(app.getHttpServer())
        .post('/api/app-versions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          version: '1.0.0',
          platform: 'web',
          deviceOs: 'ios',
          releaseDate: '2026-04-20T00:00:00.000Z',
        })
        .expect(201);
      expect(res.body.deviceOs).toBeNull();
    });

    // The whole reason deviceOs exists: iOS and Android are versioned
    // independently, so the same version string on each is two valid rows.
    it('lets two trains on one platform share a version string', async () => {
      const { token } = await createPlatformAdmin(app);
      for (const deviceOs of ['ios', 'android']) {
        await request(app.getHttpServer())
          .post('/api/app-versions')
          .set('Authorization', `Bearer ${token}`)
          .send({
            version: '4.1.0',
            platform: 'mobile',
            deviceOs,
            releaseDate: '2026-04-20T00:00:00.000Z',
          })
          .expect(201);
      }
    });

    it('resolves /latest per train, not per platform', async () => {
      const { token } = await createPlatformAdmin(app);
      await request(app.getHttpServer())
        .post('/api/app-versions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          version: '5.0.0-ios',
          platform: 'mobile',
          deviceOs: 'ios',
          releaseDate: '2026-01-01T00:00:00.000Z',
        })
        .expect(201);
      // Newer by date, but a DIFFERENT train — an iOS client must not be
      // offered it.
      await request(app.getHttpServer())
        .post('/api/app-versions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          version: '9.0.0-android',
          platform: 'mobile',
          deviceOs: 'android',
          releaseDate: '2026-06-01T00:00:00.000Z',
        })
        .expect(201);

      const iosRes = await request(app.getHttpServer())
        .get('/api/app-versions/latest?platform=mobile&os=ios')
        .expect(200);
      expect(iosRes.body.version).toBe('5.0.0-ios');

      const androidRes = await request(app.getHttpServer())
        .get('/api/app-versions/latest?platform=mobile&os=android')
        .expect(200);
      expect(androidRes.body.version).toBe('9.0.0-android');
    });

    it('requires os on /latest for a multi-train platform, and rejects a foreign one', async () => {
      await request(app.getHttpServer())
        .get('/api/app-versions/latest?platform=mobile')
        .expect(400);
      await request(app.getHttpServer())
        .get('/api/app-versions/latest?platform=mobile&os=not-an-os')
        .expect(400);
    });

    // A PATCH that says nothing about the train must not blank it.
    it('leaves the stored train untouched on an unrelated PATCH', async () => {
      const { token } = await createPlatformAdmin(app);
      const created = await request(app.getHttpServer())
        .post('/api/app-versions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          version: '6.0.0',
          platform: 'mobile',
          deviceOs: 'ios',
          releaseDate: '2026-04-20T00:00:00.000Z',
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .patch(`/api/app-versions/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ description: 'Notes only' })
        .expect(200);
      expect(res.body.deviceOs).toBe('ios');
    });
  });

  describe('duplicate versions', () => {
    it('rejects a duplicate within one train with 409', async () => {
      const { token } = await createPlatformAdmin(app);
      const payload = {
        version: '1.0.0',
        platform: 'mobile',
        deviceOs: 'ios',
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

    // The gap the service-level guard exists to close. `web` rows carry a NULL
    // deviceOs, and Postgres treats NULLs as distinct in a unique index — so
    // the DB constraint alone would let both of these insert.
    it('rejects a duplicate web version with 409, despite the NULL-distinct index', async () => {
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

    it('rejects a PATCH that collides with another row, but allows a no-op self-patch', async () => {
      const { token } = await createPlatformAdmin(app);
      await request(app.getHttpServer())
        .post('/api/app-versions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          version: '1.0.0',
          platform: 'web',
          releaseDate: '2026-01-01T00:00:00.000Z',
        })
        .expect(201);
      const second = await request(app.getHttpServer())
        .post('/api/app-versions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          version: '2.0.0',
          platform: 'web',
          releaseDate: '2026-02-01T00:00:00.000Z',
        })
        .expect(201);

      await request(app.getHttpServer())
        .patch(`/api/app-versions/${second.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ version: '1.0.0' })
        .expect(409);

      // The row must not collide with ITSELF — `excludeId` in the guard.
      await request(app.getHttpServer())
        .patch(`/api/app-versions/${second.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ version: '2.0.0', description: 'Same version, new notes' })
        .expect(200);
    });
  });

  // The API stores and returns UTC only, so a zoneless timestamp is rejected
  // rather than silently resolved against the server's clock.
  it('POST /api/app-versions rejects a non-UTC releaseDate with 400', async () => {
    const { token } = await createPlatformAdmin(app);
    for (const releaseDate of [
      '2026-04-20T00:00:00',
      '2026-04-20T00:00:00+03:00',
      '2026-04-20',
    ]) {
      await request(app.getHttpServer())
        .post('/api/app-versions')
        .set('Authorization', `Bearer ${token}`)
        .send({ version: '1.0.0', platform: 'web', releaseDate })
        .expect(400);
    }
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
        deviceOs: 'ios',
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

  it('GET /api/app-versions/latest returns the newest version for a train', async () => {
    const { token } = await createPlatformAdmin(app);
    // Older mobile release
    await request(app.getHttpServer())
      .post('/api/app-versions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        version: '1.0.0',
        platform: 'mobile',
        deviceOs: 'ios',
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
        deviceOs: 'ios',
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
      .get('/api/app-versions/latest?platform=mobile&os=ios')
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
        deviceOs: 'macos',
        releaseDate: '2026-04-01T00:00:00.000Z',
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/app-versions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        version: '2.0.0',
        platform: 'desktop',
        deviceOs: 'macos',
        releaseDate: '2026-03-01T00:00:00.000Z',
      })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/api/app-versions/${newer.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    const res = await request(app.getHttpServer())
      .get('/api/app-versions/latest?platform=desktop&os=macos')
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
        deviceOs: 'linux',
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
