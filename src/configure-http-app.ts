import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

// Everything Swagger serves — the UI, its init script (which embeds the whole
// document), and the raw JSON and YAML documents — lives under this ONE
// subtree. The edge (docs/staging/Caddyfile) protects the subtree, not a list
// of file names: Swagger's defaults put the raw documents at SIBLINGS
// (`/api/docs-json`, `/api/docs-yaml`), which a subtree match cannot see and a
// hand-kept list silently misses.
export const SWAGGER_UI_PATH = 'api/docs';
export const SWAGGER_JSON_PATH = `${SWAGGER_UI_PATH}/json`;
export const SWAGGER_YAML_PATH = `${SWAGGER_UI_PATH}/yaml`;

// The HTTP edge of the application, applied by `main.ts` and by the e2e
// harness alike, so a test exercises the same headers, CORS, proxy trust,
// prefix and Swagger gate that production serves — not a hand-made subset.
export function configureHttpApp(app: NestExpressApplication): void {
  const configService = app.get(ConfigService);
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
    SwaggerModule.setup(SWAGGER_UI_PATH, app, document, {
      jsonDocumentUrl: SWAGGER_JSON_PATH,
      yamlDocumentUrl: SWAGGER_YAML_PATH,
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
}
