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

  it('GET /api/health/readiness -> 200 with database and queue up', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/health/readiness')
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      info: {
        database: { status: 'up' },
        // Queue CONNECTIVITY belongs on readiness — an API that accepts a
        // request it cannot enqueue follow-up work for is not ready.
        queue: { status: 'up' },
      },
    });
  });

  // Worker liveness is deliberately NOT on readiness: a restarting worker must
  // not pull the whole API out of the load balancer. Asserted here because
  // "someone helpfully adds it to readiness" is the exact regression that would
  // otherwise go unnoticed until a deploy took the API down with it.
  it('GET /api/health/readiness omits worker liveness', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/health/readiness')
      .expect(200);
    expect(res.body).not.toHaveProperty('info.queue_worker');
    expect(res.body).not.toHaveProperty('details.queue_worker');
  });

  // `GET /api/health/workers` is deliberately NOT asserted here. Its answer
  // depends on whether a heartbeat key exists in THIS jest worker's Redis
  // database — state this spec neither seeds nor flushes (it calls no
  // `truncateAll`), and which the queue spec legitimately leaves behind for up
  // to the key's TTL when the two land on the same worker. Asserting it here
  // would pass or fail on spec ordering.
  //
  // Both of its outcomes are covered where that state IS owned:
  // `queue.e2e-spec.ts` flushes Redis, then asserts 503 with no heartbeat and
  // 200 once a real worker has beaten.
});
