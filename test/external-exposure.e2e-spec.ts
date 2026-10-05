import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { existsSync, readFileSync } from 'fs';
import { request as httpRequest } from 'http';
import { AddressInfo } from 'net';
import { resolve } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  SWAGGER_JSON_PATH,
  SWAGGER_UI_PATH,
  SWAGGER_YAML_PATH,
} from '../src/configure-http-app';
import { truncateAll } from './setup/db';
import { seedRbacCatalog } from './setup/rbac';
import { RedisService } from '../src/common/redis/redis.service';
import { createTestApp } from './setup/test-app';

// What an anonymous client can pull off the public HTTP surface.
//
// Every assertion is about CONTENT. A status code alone proves nothing here: a
// fallback handler can answer 200 with an HTML shell, a redirect can hand the
// file over one hop later, and a 404 page can echo what it refused. So each
// probe also asserts that no line of the real file on disk, and no runtime
// secret, appears anywhere in what came back.
//
// Requests go out over a raw socket, not supertest: its URL parsing collapses
// `/api/../.env` and `%2e%2e` before they are sent, so the traversal probes
// would silently test the normalised path instead.

const REPOSITORY_ROOT = resolve(__dirname, '..');

// Files that exist in the repository, the build context or the image, and
// must never be readable over HTTP. Absent ones (no `dist/` before a build, no
// `.git` in some checkouts) are skipped; the list is asserted non-empty.
const SENSITIVE_FILES = [
  '.env.test',
  '.env.example',
  '.git/HEAD',
  '.git/config',
  'package.json',
  'yarn.lock',
  'tsconfig.json',
  'prisma/schema.prisma',
  'prisma.config.ts',
  'src/main.ts',
  'dist/main.js',
  'dist/main.js.map',
  'docs/prod/backup.sh',
];

const PROBE_PATHS = [
  '/',
  '/index.html',
  '/.env',
  '/.env.test',
  '/.env.example',
  '/api/.env',
  '/.git/HEAD',
  '/.git/config',
  '/api/.git/config',
  '/package.json',
  '/api/package.json',
  '/yarn.lock',
  '/tsconfig.json',
  '/prisma/schema.prisma',
  '/api/prisma/schema.prisma',
  '/prisma.config.ts',
  '/src/main.ts',
  '/main.js',
  '/main.js.map',
  '/dist/main.js',
  '/dist/main.js.map',
  '/api/main.js.map',
  '/node_modules/.prisma/client/schema.prisma',
  '/docs/prod/backup.sh',
  '/backups/',
  '/logs/',
  '/uploads/',
  '/api/uploads/avatar.png',
  '/api/../.env',
  '/api/%2e%2e/.env',
  '/api/..%2f.env',
  '/api/health/..%2f..%2fpackage.json',
  '/%2e%2e/%2e%2e/etc/passwd',
  '/metrics',
  '/api/metrics',
  '/api/debug',
];

// Every URL Swagger could serve, under its own subtree and at the sibling
// locations it uses by default. All of them must be dark in production.
const SWAGGER_PROBE_PATHS = [
  `/${SWAGGER_UI_PATH}`,
  `/${SWAGGER_UI_PATH}/`,
  `/${SWAGGER_UI_PATH}/swagger-ui-init.js`,
  `/${SWAGGER_JSON_PATH}`,
  `/${SWAGGER_YAML_PATH}`,
  `/${SWAGGER_JSON_PATH.toUpperCase()}`,
  '/api/docs-json',
  '/api/docs-yaml',
];

// Markers any Swagger artifact carries — the document itself, or the UI init
// script that embeds it.
const SWAGGER_MARKERS = ['"openapi"', 'openapi:', 'swaggerDoc', 'SwaggerUI'];

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function rawGet(
  app: INestApplication,
  path: string,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  const { port } = (
    app.getHttpServer() as { address(): AddressInfo }
  ).address();
  return new Promise((resolvePromise, reject) => {
    const outgoing = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () =>
          resolvePromise({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

// Distinctive lines of every sensitive file present on disk: long enough that
// an innocent JSON error envelope cannot contain one by coincidence.
function sensitiveContentMarkers(): string[] {
  const markers = new Set<string>();
  for (const relativePath of SENSITIVE_FILES) {
    const absolutePath = resolve(REPOSITORY_ROOT, relativePath);
    if (!existsSync(absolutePath)) continue;
    readFileSync(absolutePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length >= 16)
      .slice(0, 50)
      .forEach((line) => markers.add(line));
  }
  return [...markers];
}

function runtimeSecrets(): string[] {
  return [
    'JWT_SECRET',
    'DB_PASSWORD',
    'REDIS_PASSWORD',
    'DATABASE_URL',
    'REDIS_URL',
    'RESEND_API_KEY',
    'TWILIO_AUTH_TOKEN',
  ]
    .map((name) => process.env[name])
    .filter((value): value is string => !!value && value.length >= 8);
}

function expectNothingSensitive(
  response: RawResponse,
  markers: string[],
): void {
  for (const marker of markers) {
    expect(response.body).not.toContain(marker);
  }
  for (const swaggerMarker of SWAGGER_MARKERS) {
    expect(response.body).not.toContain(swaggerMarker);
  }
  // A stack trace would disclose file layout and dependency versions.
  expect(response.body).not.toMatch(/\n\s+at \S+ \(/);
}

// NODE_ENV=production, with inert provider settings. What a production boot
// re-resolves here is `configuration.ts` — the Swagger gate, CORS, trust
// proxy, throttler storage — not the Joi schema, which validated `.env.test`
// once at import; env.validation.spec.ts owns the production refusals.
// SWAGGER_ENABLED=true on purpose: the production floor must win over an
// operator who turns Swagger on.
const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  SWAGGER_ENABLED: 'true',
  CORS_ORIGIN: 'https://www.example.test',
  TRUST_PROXY: '2',
  EMAIL_PROVIDER: 'resend',
  EMAIL_FROM: 'no-reply@example.test',
  RESEND_API_KEY: 're_exposure_spec_inert_key',
  SMS_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: `AC${'0'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'exposure-spec-inert-token',
  TWILIO_FROM: '+15005550006',
} as const satisfies Record<string, string>;

describe('External exposure (e2e)', () => {
  describe('production runtime', () => {
    let app: INestApplication<App>;
    const originalEnv: Record<string, string | undefined> = {};
    let markers: string[];

    beforeAll(async () => {
      // The deploy order: the migrate step projects the permission catalog
      // (`rbac:sync`) before the API starts, and a production boot refuses to
      // start without it. A test-mode app does the projecting here, on a
      // truncated database: a production boot also refuses rows an earlier
      // spec in this worker left behind.
      const seedingApp: INestApplication<App> = await createTestApp();
      await truncateAll(seedingApp);
      await seedRbacCatalog(seedingApp);
      await seedingApp.close();

      for (const [name, value] of Object.entries(PRODUCTION_ENV)) {
        originalEnv[name] = process.env[name];
        process.env[name] = value;
      }
      app = await createTestApp();
      markers = [...sensitiveContentMarkers(), ...runtimeSecrets()];
    });

    afterAll(async () => {
      // Restore first: a failed boot must not leak production mode into the
      // Swagger-enabled block below.
      for (const [name, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await app?.close();
    });

    it('has real file content and secrets to look for', () => {
      // Guards against a vacuous pass: with no markers every probe "passes".
      expect(markers.length).toBeGreaterThan(50);
      expect(runtimeSecrets().length).toBeGreaterThanOrEqual(5);
    });

    it.each(PROBE_PATHS)(
      'GET %s serves no file, source, schema or secret',
      async (path) => {
        const response = await rawGet(app, path);

        // Not a success, not a redirect to somewhere that might succeed, and
        // not an HTML fallback shell — the standard JSON error envelope.
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.headers.location).toBeUndefined();
        expect(response.headers['content-type']).toMatch(/application\/json/);
        expectNothingSensitive(response, markers);
      },
    );

    it.each(SWAGGER_PROBE_PATHS)(
      'GET %s serves no API schema even with SWAGGER_ENABLED=true',
      async (path) => {
        const response = await rawGet(app, path);

        expect(response.status).toBe(404);
        expect(response.headers.location).toBeUndefined();
        expectNothingSensitive(response, markers);
      },
    );

    it.each([
      '/api/health/liveness',
      '/api/health/readiness',
      '/api/health/workers',
      '/api/health/version',
    ])('GET %s discloses no connection string or secret', async (path) => {
      const response = await rawGet(app, path);

      // The route answered (a 503 is a failing check, still a real body) —
      // a renamed route would 404 and leave the content assertions vacuous.
      expect([200, 503]).toContain(response.status);
      expect(response.body.length).toBeGreaterThan(0);
      expectNothingSensitive(response, markers);
      expect(response.body).not.toMatch(/postgres(ql)?:\/\//);
      expect(response.body).not.toMatch(/rediss?:\/\//);
    });

    // The edge (docs/prod/Caddyfile) hands the app ONE forwarded address — the
    // client's. With the production TRUST_PROXY, per-IP limits must key on that
    // address, not on the proxy in front: the defect this guards against put
    // every caller behind Cloudflare in one bucket. Runs on the Redis-backed
    // throttler storage, which is live only outside NODE_ENV=test.
    it('keys per-IP rate limits on the forwarded client address', async () => {
      const resendVerification = (clientAddress: string) =>
        request(app.getHttpServer())
          .post('/api/auth/resend-verification')
          .set('X-Forwarded-For', clientAddress)
          .send({ email: 'nobody@example.test' });

      // The route allows 3 per minute per client (auth.controller.ts).
      for (let attempt = 0; attempt < 3; attempt++) {
        expect((await resendVerification('203.0.113.7')).status).toBe(200);
      }
      expect((await resendVerification('203.0.113.7')).status).toBe(429);
      expect((await resendVerification('203.0.113.8')).status).toBe(200);
    });

    it('applies the production HTTP edge: Helmet headers and a closed CORS origin', async () => {
      const response = await rawGet(app, '/api/public/ping', {
        Origin: 'https://attacker.example',
      });

      // Positive control: the raw client reads bodies, so the probes above
      // would have seen file content had any been served.
      expect(response.status).toBe(200);
      expect(response.body.length).toBeGreaterThan(0);
      expect(response.headers['x-powered-by']).toBeUndefined();
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['access-control-allow-origin']).toBeUndefined();

      // ...while the configured origin is still allowed, with credentials.
      const allowed = await rawGet(app, '/api/public/ping', {
        Origin: PRODUCTION_ENV.CORS_ORIGIN,
      });
      expect(allowed.headers['access-control-allow-origin']).toBe(
        PRODUCTION_ENV.CORS_ORIGIN,
      );
      expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    });

    it('counts rate limits in Redis on the shared, app-owned client', () => {
      // Shared across pods (not in-memory), and on the one client RedisService
      // closes at shutdown — the library never closes a client handed to it.
      const storage = app.get(ThrottlerStorage);
      expect(storage).toBeInstanceOf(ThrottlerStorageRedisService);
      expect((storage as ThrottlerStorageRedisService).redis).toBe(
        app.get(RedisService).client,
      );
    });
  });

  // Staging and development serve Swagger; the edge protects it by matching
  // one subtree (docs/staging/Caddyfile). That only holds while Swagger
  // registers nothing outside the subtree.
  describe('Swagger-enabled runtime', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      app = await createTestApp();
      // Guard for filtered runs: the absence probes below mean something only
      // while Swagger is actually on.
      const json = await rawGet(app, `/${SWAGGER_JSON_PATH}`);
      if (!json.body.includes('"openapi"')) {
        throw new Error(
          'Swagger is not being served; the probes would be vacuous',
        );
      }
    });

    afterAll(async () => {
      await app.close();
    });

    // The subtree is named twice — here and in the Caddy matcher — so tie
    // them: moving SWAGGER_UI_PATH without the edge would leave staging's
    // schema served from a path the basic-auth matcher no longer covers.
    it.each(['docs/staging/Caddyfile', 'docs/prod/Caddyfile'])(
      '%s matches exactly the Swagger subtree',
      (caddyfile) => {
        const contents = readFileSync(
          resolve(REPOSITORY_ROOT, caddyfile),
          'utf8',
        );
        expect(contents).toContain(
          `@docs path /${SWAGGER_UI_PATH} /${SWAGGER_UI_PATH}/*\n`,
        );
        // The client address per-IP limits and the audit trail key on — see
        // 'keys per-IP rate limits on the forwarded client address'.
        expect(contents).toContain(
          'header_up X-Forwarded-For {http.request.header.CF-Connecting-IP}',
        );
        if (caddyfile.includes('staging')) {
          expect(contents).toMatch(/^\s*basic_auth @docs \{/m);
        }
      },
    );

    it('points the DAST scan at the served JSON document', () => {
      const workflow = readFileSync(
        resolve(REPOSITORY_ROOT, '.github/workflows/security-dast.yml'),
        'utf8',
      );
      expect(workflow).toContain(`/${SWAGGER_JSON_PATH} `);
    });

    it('serves the JSON and YAML documents inside the protected subtree', async () => {
      // Positive controls: the markers do detect a served schema.
      const json = await rawGet(app, `/${SWAGGER_JSON_PATH}`);
      expect(json.status).toBe(200);
      expect(json.body).toContain('"openapi"');

      const yaml = await rawGet(app, `/${SWAGGER_YAML_PATH}`);
      expect(yaml.status).toBe(200);
      expect(yaml.body).toContain('openapi:');
    });

    it.each([
      '/api/docs-json',
      '/api/docs-yaml',
      '/api/docs-json;x',
      '/api/docs-json.',
      '/api/swagger',
      '/api/swagger.json',
      '/swagger-ui-init.js',
    ])('GET %s serves no schema outside the subtree', async (path) => {
      const response = await rawGet(app, path);

      for (const swaggerMarker of SWAGGER_MARKERS) {
        expect(response.body).not.toContain(swaggerMarker);
      }
    });
  });
});
