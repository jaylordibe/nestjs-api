// MUST be first: OpenTelemetry auto-instrumentation patches `http`, `pg`, and
// `ioredis` as they are required, so anything imported above this line keeps an
// unpatched reference and silently never produces spans. See src/telemetry.ts.
import { startTelemetry } from './telemetry';

startTelemetry();

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import {
  configureHttpApp,
  SingleAppExpressAdapter,
} from './configure-http-app';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    new SingleAppExpressAdapter(),
    { bufferLogs: true },
  );
  app.useLogger(app.get(Logger));

  configureHttpApp(app);
  const port = app.get(ConfigService).getOrThrow<number>('port');

  // Also drives TelemetryShutdownService, which flushes spans and metrics so
  // the final seconds before a deploy or restart — the window you actually go
  // looking for — are not the ones that get dropped.
  app.enableShutdownHooks();

  // Bound to 0.0.0.0, not the Node default. Nest's default binds every
  // interface today, but stating it removes the dependency on that default:
  // a container platform routes to the container's own IP, so a process that
  // ended up on loopback would be unreachable from outside while reporting
  // itself perfectly healthy from inside — a failure that presents as "the
  // container never became ready" with nothing in the logs to explain it.
  //
  // `port` is `PORT` from config, defaulting to 3000. Nothing here is
  // hard-coded to any platform's convention: a host that injects `PORT`
  // (managed container runtimes commonly do — 8080 is a frequent choice) simply
  // wins, and a host that does not gets the default. That is the whole reason
  // the port is configuration rather than a constant.
  await app.listen(port, '0.0.0.0');
  app
    .get(Logger)
    .log(`API listening on port ${port}, prefix /api`, 'Bootstrap');
}

void bootstrap();
