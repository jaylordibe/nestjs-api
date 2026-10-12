import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { truncateAll } from './setup/db';
import { seedRbacCatalog } from './setup/rbac';
import { createTestApp } from './setup/test-app';

// The Turnstile bot check with both secrets set — the staging and production
// shape. Siteverify is stubbed at `fetch`: token PASS is genuine, anything else
// is refused. Every other spec runs with the check off (.env.test sets no
// secret), so locally and in tests every action works without a token.

const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const PASS = 'genuine-widget-token';
const WEB_SECRET = 'e2e-web-widget-secret';
const MOBILE_SECRET = 'e2e-mobile-widget-secret';
const VALID_PASSWORD = 'correct-horse-battery-1';

const PROTECTED_ROUTES = [
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/resend-verification',
  '/api/users/request-password-reset',
];

// Public writes that respond exactly as before, with no token.
const UNPROTECTED_ROUTES = [
  '/api/auth/refresh',
  '/api/auth/verify-email',
  '/api/users/reset-password',
];

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const registerBody = (email: string) => ({
  email,
  password: VALID_PASSWORD,
  firstName: 'Alice',
  lastName: 'Smith',
});

describe('Turnstile bot check (e2e)', () => {
  const originalSecrets = {
    web: process.env.TURNSTILE_WEB_SECRET,
    mobile: process.env.TURNSTILE_MOBILE_SECRET,
  };
  const realFetch = globalThis.fetch;
  let app: INestApplication<App>;
  let siteverifySecrets: string[];
  let fetchSpy: jest.SpyInstance;

  beforeAll(async () => {
    // Before the module compiles: the config factory re-runs per AppModule.
    process.env.TURNSTILE_WEB_SECRET = WEB_SECRET;
    process.env.TURNSTILE_MOBILE_SECRET = MOBILE_SECRET;
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    // `process.env.X = undefined` would store the string "undefined" and switch
    // the check on for every later spec in this worker.
    restoreEnvironment('TURNSTILE_WEB_SECRET', originalSecrets.web);
    restoreEnvironment('TURNSTILE_MOBILE_SECRET', originalSecrets.mobile);
  });

  beforeEach(async () => {
    await truncateAll(app);
    await seedRbacCatalog(app);
    siteverifySecrets = [];
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url !== SITEVERIFY_URL) return realFetch(input, init);
        const form = init?.body as URLSearchParams;
        siteverifySecrets.push(form.get('secret') ?? '');
        const isGenuine = form.get('response') === PASS;
        return Promise.resolve(
          new Response(
            JSON.stringify(
              isGenuine
                ? { success: true }
                : { success: false, 'error-codes': ['invalid-input-response'] },
            ),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const server = () => app.getHttpServer();
  const userCount = () => app.get(PrismaService).user.count();

  function register(headers: Record<string, string>): request.Test {
    return request(server())
      .post('/api/auth/register')
      .set(headers)
      .send(registerBody('alice@example.com'));
  }

  // The empty body would fail validation, so a TURNSTILE_ code proves the
  // check runs before validation and the handler: nothing can have happened.
  it.each(PROTECTED_ROUTES)(
    'refuses %s without a token, before validating the body',
    async (route) => {
      const response = await request(server()).post(route).send({}).expect(400);
      expect(response.body.errorCode).toBe('TURNSTILE_TOKEN_MISSING');
      expect(siteverifySecrets).toEqual([]);
    },
  );

  it('creates nothing when the token is missing', async () => {
    await register({}).expect(400);
    expect(await userCount()).toBe(0);
  });

  // A genuine app token, verified against the app's widget.
  it('lets a genuine token through, and the action behaves as before', async () => {
    await register({ 'X-Turnstile-Token': PASS }).expect(201);
    expect(await userCount()).toBe(1);
    expect(siteverifySecrets).toEqual([MOBILE_SECRET]);
  });

  it("verifies a request with a browser Origin against the website's widget", async () => {
    await register({
      'X-Turnstile-Token': PASS,
      Origin: 'https://www.example.com',
    }).expect(201);
    expect(siteverifySecrets).toEqual([WEB_SECRET]);
  });

  it('refuses a token Cloudflare rejects, and creates nothing', async () => {
    const response = await register({
      'X-Turnstile-Token': 'forged-token',
    }).expect(400);
    expect(response.body).toMatchObject({
      errorCode: 'TURNSTILE_TOKEN_INVALID',
      details: null,
    });
    expect(await userCount()).toBe(0);
  });

  it.each(UNPROTECTED_ROUTES)('asks no token on %s', async (route) => {
    const response = await request(server()).post(route).send({});
    // The answer to an empty body: a validation or auth refusal, never a
    // missing route or a crash, and never the bot check.
    expect([400, 401]).toContain(response.status);
    expect(String(response.body.errorCode)).not.toMatch(/^TURNSTILE_/);
    expect(siteverifySecrets).toEqual([]);
  });

  // Browser clients must be able to send the header cross-origin.
  it('lets a browser preflight send the token header', async () => {
    const response = await request(server())
      .options('/api/auth/login')
      .set('Origin', 'https://www.example.com')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-turnstile-token');
    expect(response.status).toBeLessThan(300);
    expect(
      String(response.headers['access-control-allow-headers']).toLowerCase(),
    ).toContain('x-turnstile-token');
  });

  // Generated web and app clients learn the requirement from here.
  it('documents the header as required on exactly the protected operations', async () => {
    const response = await request(server()).get('/api/docs/json').expect(200);
    const paths = response.body.paths as Record<
      string,
      Record<
        string,
        { parameters?: Array<{ in: string; name: string; required?: boolean }> }
      >
    >;
    const documented = Object.entries(paths).flatMap(([path, operations]) =>
      Object.entries(operations)
        .filter(([, operation]) =>
          (operation.parameters ?? []).some(
            (parameter) =>
              parameter.in === 'header' &&
              parameter.name === 'X-Turnstile-Token' &&
              parameter.required === true,
          ),
        )
        .map(([method]) => `${method.toUpperCase()} ${path}`),
    );
    expect(documented.sort()).toEqual(
      PROTECTED_ROUTES.map((route) => `POST ${route}`).sort(),
    );
  });
});

// Cloudflare stops answering, through the real app and the real audit table.
// Its own app, because an open breaker lasts 30 seconds and would change every
// other case's outcome.
describe('Turnstile bot check during a Cloudflare outage (e2e)', () => {
  const originalSecrets = {
    web: process.env.TURNSTILE_WEB_SECRET,
    mobile: process.env.TURNSTILE_MOBILE_SECRET,
  };
  const realFetch = globalThis.fetch;
  let app: INestApplication<App>;
  let fetchSpy: jest.SpyInstance;
  let siteverifyCalls = 0;

  beforeAll(async () => {
    process.env.TURNSTILE_WEB_SECRET = WEB_SECRET;
    process.env.TURNSTILE_MOBILE_SECRET = MOBILE_SECRET;
    app = await createTestApp();
    await truncateAll(app);
    await seedRbacCatalog(app);
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url !== SITEVERIFY_URL) return realFetch(input, init);
        siteverifyCalls += 1;
        return Promise.reject(new TypeError('fetch failed'));
      });
  });

  afterAll(async () => {
    fetchSpy.mockRestore();
    await app.close();
    restoreEnvironment('TURNSTILE_WEB_SECRET', originalSecrets.web);
    restoreEnvironment('TURNSTILE_MOBILE_SECRET', originalSecrets.mobile);
  });

  const register = (headers: Record<string, string>, email: string) =>
    request(app.getHttpServer())
      .post('/api/auth/register')
      .set(headers)
      .send(registerBody(email));

  it('refuses with a retryable error, then lets token-bearing requests through, each audited, and still refuses no token', async () => {
    const token = { 'X-Turnstile-Token': 'token-during-outage' };

    for (const email of ['outage1@example.com', 'outage2@example.com']) {
      const refused = await register(token, email).expect(503);
      expect(refused.body.errorCode).toBe('EXTERNAL_SERVICE_UNAVAILABLE');
    }

    await register(token, 'outage3@example.com').expect(201);
    await register(token, 'outage4@example.com').expect(201);

    // The third no-answer opened the window; the fourth never asked Cloudflare.
    expect(siteverifyCalls).toBe(3);

    const missing = await register({}, 'outage5@example.com').expect(400);
    expect(missing.body.errorCode).toBe('TURNSTILE_TOKEN_MISSING');

    const rows = await app.get(PrismaService).auditLog.findMany({
      where: { action: 'turnstile.verification_bypassed' },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.actorId).toBeNull();
      expect(row.metadata).toMatchObject({ widget: 'mobile' });
      expect(JSON.stringify(row.metadata)).not.toContain('token-during-outage');
    }
  });
});
