import { INestApplication } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import helmet from 'helmet';
import { AppModule } from '../../src/app.module';

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

  // Nothing is disarmed here, and nothing needs to be. There is no in-process
  // scheduler: all background work — including recurring work — runs on BullMQ,
  // and `.env.test` sets QUEUE_WORKER_ENABLED=false, so a test app neither
  // consumes jobs nor installs job schedulers. Tests are driven by their own
  // arrange step, never by the clock.
  //
  // `queue.e2e-spec.ts` is the deliberate exception: it flips the flag for
  // itself before compiling the module, and is the only spec with a live
  // consumer acting on the database its assertions read.
  //
  // Job LOGIC stays fully testable regardless: each handler's seam
  // (`runOnce()`, …) is a plain method a spec calls directly.
  return app;
}
