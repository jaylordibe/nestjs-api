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
      corsOrigin === '*' ? true : corsOrigin.split(',').map((o) => o.trim()),
    credentials: true,
  });

  // Swagger gate: local + staging expose `/api/docs`; production hides
  // it. Operators don't need it on the customer-facing host, and the
  // schema dump leaks DTO shape to anonymous traffic. Staging keeps it
  // because that's where integration partners and admins actually use
  // Try-it-out. Branches on NODE_ENV.
  const nodeEnv = configService.getOrThrow<string>('nodeEnv');
  if (nodeEnv !== 'production') {
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

  app.enableShutdownHooks();

  await app.listen(port);
  app
    .get(Logger)
    .log(`API listening on http://localhost:${port}/api`, 'Bootstrap');
}

void bootstrap();
