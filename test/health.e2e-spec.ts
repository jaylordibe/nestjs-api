import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './setup/test-app';

describe('Health (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health/liveness -> 200', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/health/liveness')
      .expect(200);
    expect(res.body).toMatchObject({ status: 'ok' });
  });

  it('GET /api/health/readiness -> 200 with database up', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/health/readiness')
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      info: { database: { status: 'up' } },
    });
  });
});
