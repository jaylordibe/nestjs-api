// MUST be first: OpenTelemetry auto-instrumentation patches `http`, `pg`, and
// `ioredis` as they are required, so anything imported above this line keeps an
// unpatched reference and silently never produces spans. See src/telemetry.ts.
import { startTelemetry } from './telemetry';

startTelemetry();

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  const configService = app.get(ConfigService);
  const port = configService.getOrThrow<number>('port');
  const corsOrigin = configService.get<string>('cors.origin') ?? '*';
  const trustProxy = configService.getOrThrow<boolean | number | string>(
    'trustProxy',
  );

  app.set('trust proxy', trustProxy);
  app.use(helmet());
  app.setGlobalPrefix('api');
  app.enableCors({
    origin:
      corsOrigin === '*'
        ? true
        : corsOrigin.split(',').map((origin) => origin.trim()),
    credentials: true,
  });

  // Swagger gate. Production is hard-off — the schema dump describes every DTO
  // and route to anonymous traffic, and there is no deployment where that
  // belongs on the customer-facing host. Non-production defaults to ON, because
  // that is where integration partners and admins actually use Try-it-out, and
  // can be turned off with SWAGGER_ENABLED=false. The resolution of both lives
  // in `configuration.ts` so the production floor is stated once.
  if (configService.getOrThrow<boolean>('swagger.enabled')) {
    // Stamp the commit hash into the Swagger doc's `version` so the
    // docs page shows which build it's describing. Mismatch with the
    // live API means a stale image is serving — pair with the health
    // endpoint to confirm. Truncate to 12 chars to match standard
    // short-SHA convention.
    const gitSha = configService.getOrThrow<string>('gitSha');
    const docVersion =
      gitSha === 'unknown' ? '1.0' : `1.0+${gitSha.slice(0, 12)}`;
    const swaggerConfig = new DocumentBuilder()
      .setTitle(configService.getOrThrow<string>('serviceName'))
      .setDescription('NestJS API')
      .setVersion(docVersion)
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: {
        // Force schemas to render fully expanded — without this, complex
        // refs inside multipart request bodies show only "object" and
        // the fields are hidden behind a click-to-expand. -1 = unlimited.
        defaultModelsExpandDepth: 2,
        defaultModelExpandDepth: 5,
        // Render request bodies with a starting example matching the
        // schema so operators see realistic input shapes in Try-it-out.
        tryItOutEnabled: true,
        // Sort the sidebar A→Z so an endpoint is easy to find: `tagsSorter`
        // orders the @ApiTags groups, `operationsSorter: 'alpha'` orders the
        // routes by path within each group (use 'method' to order by HTTP verb
        // instead). Without these, both render in controller-declaration order.
        tagsSorter: 'alpha',
        operationsSorter: 'alpha',
      },
    });
  }

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
