import { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import helmet from 'helmet';
import { AppModule } from '../../src/app.module';
import { removeAllScheduledTasks } from '../../src/common/util/scheduled-task-teardown.util';

// Optional hook for swapping providers in a single spec (e.g. stubbing a
// third-party client so tests make no outbound HTTP calls, or wrapping a queue
// job handler to observe what the worker actually did). The callback is given
// the un-compiled builder so it can chain `.overrideProvider(X).useValue(...)`.
export async function createTestApp(
  configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
): Promise<INestApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (configure) {
    builder = configure(builder);
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication();
  app.use(helmet());
  app.setGlobalPrefix('api');

  // LOAD-BEARING: `listen(0)` here, not a bare `init()`.
  //
  // supertest's contract is "if the server you hand me isn't listening, I'll
  // listen(0) on it — and close it again once the response lands". With a
  // non-listening server (what `init()` alone leaves behind) EVERY request in
  // the suite binds a fresh ephemeral port and tears it down. `server.close()`
  // is async and the port returns to the OS immediately, so a request
  // occasionally dials a port already reassigned to something else — yielding
  // `socket hang up` (RST) or `Parse Error: Expected HTTP/, RTSP/ or ICE/`
  // (reading a foreign protocol's bytes), on a different test each run. That is
  // the classic "flaky e2e suite" in a NestJS repo, and it is not flaky code.
  //
  // Binding once up front means `server.address()` is always set, so supertest
  // never adopts the server and never closes it — one stable listener for the
  // whole file, torn down by the spec's `app.close()`. Port 0 = OS-assigned, so
  // parallel jest workers cannot collide.
  await app.listen(0);

  // Cron jobs are registered by `ScheduleModule.forRoot()` in AppModule and
  // fire on WALL-CLOCK boundaries. Left alive, a long spec file that straddles
  // a boundary runs background jobs against the very database the tests are
  // asserting on — writing rows, stamping columns, and contending with
  // `truncateAll`'s lock. Tests must be driven by their own arrange step, never
  // by the clock. Job LOGIC stays fully testable: each job's seam (`runOnce()`,
  // …) is a plain method a spec calls directly.
  //
  // Shared with `src/worker.ts`, which needs the identical guarantee for the
  // identical reason — and which would otherwise drift the day an @Interval is
  // added.
  removeAllScheduledTasks(app.get(SchedulerRegistry));

  return app;
}
