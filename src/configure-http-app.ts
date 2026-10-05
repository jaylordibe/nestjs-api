import { ConfigService } from '@nestjs/config';
import {
  ExpressAdapter,
  type NestExpressApplication,
} from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { fromBodyParserError } from './common/errors/errors';

// The Express adapter every entrypoint creates the application with
// (`main.ts`, and the e2e harness through `createNestApplication`).
//
// Nest 12 mounts its not-found handler under the global prefix only, so one
// Express instance can host several Nest apps. This server hosts exactly one,
// and every route it serves lives under `api` — so a request OUTSIDE the prefix
// (`GET /`, `/.env`, `/.git/HEAD`: what scanners probe first) fell through to
// Express's built-in HTML 404, skipping the exception filter, the JSON
// envelope, the request id and the log line. Mounting the same Nest handler at
// the root as well restores the v11 contract: every miss, anywhere, is
// answered through the one envelope. test/external-exposure.e2e-spec.ts pins it.
//
// It also maps the body parser's own client errors (oversized body,
// unsupported charset) to their 4xx, which Nest's adapter leaves as 500 — see
// `fromBodyParserError`. test/request-metadata.e2e-spec.ts pins that.
export class SingleAppExpressAdapter extends ExpressAdapter {
  override mapException(error: unknown): unknown {
    const mapped = super.mapException(error);
    return mapped === error ? (fromBodyParserError(error) ?? error) : mapped;
  }

  override setNotFoundHandler(
    ...args: Parameters<ExpressAdapter['setNotFoundHandler']>
  ): void {
    const [handler, prefix] = args;
    super.setNotFoundHandler(handler, prefix);
    // Without a prefix the base class has already mounted it at the root.
    if (prefix) {
      this.use(handler);
    }
  }
}

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
