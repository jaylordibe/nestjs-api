import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './setup/test-app';

// Guards the harness invariants that determinism depends on. Each was once
// violated in a real codebase and produced a flake that looked like a product
// bug — landing on a different test every run, which is the most expensive kind
// of failure to chase. A regression here would silently reintroduce that, so
// they are asserted rather than left to a comment in `setup/test-app.ts`.
describe('E2E harness invariants', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  // If the server is not already bound, supertest listens on an ephemeral port
  // per request and closes it after the response. The freed port can be handed
  // to another socket before the next request dials it, yielding `socket hang
  // up` or `Parse Error: Expected HTTP/, RTSP/ or ICE/` — an HTTP client
  // reading some other protocol's bytes.
  it('binds the HTTP server exactly once, so supertest never rebinds it', async () => {
    const server = app.getHttpServer();
    const addressBefore = server.address();
    expect(addressBefore).not.toBeNull();

    await request(server).get('/api/health/liveness').expect(200);

    // Same listener, same port, after a request has completed.
    expect(server.address()).toEqual(addressBefore);
  });

  // Cron jobs fire on wall-clock boundaries. Alive during a spec run they mutate
  // the same database the assertions read — writing rows, stamping columns,
  // contending with truncateAll's lock — so a suite that happens to straddle a
  // boundary fails somewhere unrelated. Job logic stays covered: every job's
  // seam is a plain method its spec calls directly.
  it('registers no cron jobs, so nothing is driven by the wall clock', () => {
    expect(app.get(SchedulerRegistry).getCronJobs().size).toBe(0);
  });

  // `.env.test` sets QUEUE_WORKER_ENABLED=false, so no spec except the queue's
  // own gets a live consumer acting on the database its assertions read. Same
  // reasoning as the cron teardown above, and the same failure mode if it
  // regresses — background writes landing mid-assertion, in a different spec
  // each run.
  it('runs no queue worker, so nothing consumes jobs mid-assertion', () => {
    expect(
      app.get(ConfigService).getOrThrow<boolean>('queue.workerEnabled'),
    ).toBe(false);
  });
});
