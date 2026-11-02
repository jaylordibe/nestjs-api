import { INestApplication } from '@nestjs/common';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { truncateAll } from './setup/db';
import {
  completeBrowserSignIn,
  connectWithOAuth,
  createOAuthTestApp,
  LOOPBACK_REDIRECT,
  OAuthBrowser,
  type OAuthTestApp,
  pkcePair,
  readForm,
  TestOAuthClientProvider,
} from './setup/mcp-oauth';
import {
  createPlatformAdmin,
  createRegularUser,
  createUser,
  issueAccessToken,
  seedRbacCatalog,
  type SeededUser,
  TEST_PASSWORD,
} from './setup/rbac';

// The MCP OAuth authorization server (src/modules/mcp-oauth): a client given
// only `/api/mcp` discovers where to sign in, registers itself, sends the user
// through the API's own sign-in and consent pages, and calls tools as that
// user — until the user's sessions end. The happy path runs through the
// official MCP client SDK; refusals and the n8n request shapes are raw HTTP,
// because a client SDK will not send them.
//
// Not covered here: the per-IP and per-identifier throttles on these routes.
// The throttler is skipped under NODE_ENV=test (app.module.ts); its limits are
// static values in mcp-oauth.config.ts and on the login handler.

// What n8n's "MCP OAuth2 API" credential registers (n8n source,
// packages/cli/src/oauth/oauth.service.ts): its own callback, its own name,
// no grant_types — so refresh tokens must come from the server's defaults.
const N8N_CALLBACK = 'https://n8n.example.com/rest/oauth2-credential/callback';

describe('MCP OAuth sign-in (e2e)', () => {
  let harness: OAuthTestApp;
  let app: INestApplication<App>;
  let user: SeededUser;
  const credentials = () => ({
    identifier: user.email,
    password: TEST_PASSWORD,
  });
  const openClients: Client[] = [];

  beforeAll(async () => {
    harness = await createOAuthTestApp();
    app = harness.app;
  });

  afterAll(async () => {
    await Promise.all(openClients.map((client) => client.close()));
    await app.close();
    harness.restore();
  });

  beforeEach(async () => {
    await truncateAll(app);
    await seedRbacCatalog(app);
    user = await createRegularUser(app, 'mcp-user@example.com');
  });

  async function connectClient(
    provider: TestOAuthClientProvider,
  ): Promise<Client> {
    const client = new Client({ name: 'e2e', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(harness.endpoint, {
        authProvider: provider,
      }),
    );
    openClients.push(client);
    return client;
  }

  function callMcp(accessToken: string) {
    return request(app.getHttpServer())
      .post('/api/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  }

  function registerClient(body: Record<string, unknown>) {
    return request(app.getHttpServer()).post('/oauth/register').send(body);
  }

  function authorizationUrl(
    clientId: string,
    redirectUri: string,
    challenge: string,
    extra: Record<string, string> = {},
  ): string {
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'state-123',
      scope: 'mcp:use',
      resource: harness.endpoint.toString(),
      ...extra,
    });
    return `${harness.baseUrl}/oauth/authorize?${query.toString()}`;
  }

  function exchangeCode(form: Record<string, string>) {
    return request(app.getHttpServer())
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'authorization_code', ...form });
  }

  function refresh(form: Record<string, string>) {
    return request(app.getHttpServer())
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'refresh_token', ...form });
  }

  /** Raw flow for a registered client; returns the redirect the browser reached. */
  async function signInRaw(
    clientId: string,
    redirectUri: string,
    decision: 'approve' | 'deny' = 'approve',
  ): Promise<{ callback: URL; verifier: string }> {
    const { verifier, challenge } = pkcePair();
    const callback = await completeBrowserSignIn(
      new OAuthBrowser(),
      authorizationUrl(clientId, redirectUri, challenge),
      credentials(),
      decision,
    );
    return { callback, verifier };
  }

  describe('discovery (S2)', () => {
    it('refuses an unauthenticated call with a challenge naming the resource metadata', async () => {
      const response = await callMcp('').expect(401);
      expect(response.headers['www-authenticate']).toContain(
        `resource_metadata="${harness.baseUrl}/.well-known/oauth-protected-resource/api/mcp"`,
      );
    });

    it('serves RFC 9728 protected resource metadata at the path-inserted and root locations', async () => {
      for (const path of [
        '/.well-known/oauth-protected-resource/api/mcp',
        '/.well-known/oauth-protected-resource',
      ]) {
        const response = await request(app.getHttpServer())
          .get(path)
          .expect(200);
        expect(response.body).toEqual({
          resource: harness.endpoint.toString(),
          authorization_servers: [harness.baseUrl],
          scopes_supported: ['mcp:use'],
          bearer_methods_supported: ['header'],
        });
      }
    });

    it('serves RFC 8414 authorization server metadata with PKCE S256 and registration', async () => {
      const response = await request(app.getHttpServer())
        .get('/.well-known/oauth-authorization-server')
        .expect(200);
      expect(response.body).toMatchObject({
        issuer: harness.baseUrl,
        authorization_endpoint: `${harness.baseUrl}/oauth/authorize`,
        token_endpoint: `${harness.baseUrl}/oauth/token`,
        registration_endpoint: `${harness.baseUrl}/oauth/register`,
        code_challenge_methods_supported: ['S256'],
        response_types_supported: ['code'],
        token_endpoint_auth_methods_supported: ['none'],
      });
      expect(response.body.grant_types_supported).toEqual(
        expect.arrayContaining(['authorization_code', 'refresh_token']),
      );
    });

    it('pins every advertised URL to the issuer, whatever Host or X-Forwarded-Host says', async () => {
      const response = await request(app.getHttpServer())
        .get('/.well-known/oauth-authorization-server')
        .set('Host', 'evil.example')
        .set('X-Forwarded-Host', 'evil.example')
        .set('X-Forwarded-Proto', 'https')
        .expect(200);
      const urls = Object.values(response.body as Record<string, unknown>)
        .filter((value): value is string => typeof value === 'string')
        .filter((value) => value.startsWith('http'));
      expect(urls.length).toBeGreaterThan(3);
      for (const url of urls) {
        expect(url.startsWith(harness.baseUrl)).toBe(true);
      }
    });

    it('leaves every other root path a 404', async () => {
      await request(app.getHttpServer())
        .get('/.well-known/openid-configuration')
        .expect(404);
      await request(app.getHttpServer()).get('/oauth').expect(404);
    });
  });

  describe('connecting (S1–S6, AC1, AC4)', () => {
    it('connects a client given only the URL; tools act as the signed-in user', async () => {
      const admin = await createPlatformAdmin(app, 'admin-mcp@example.com');
      const provider = await connectWithOAuth(harness.endpoint, {
        identifier: admin.email,
        password: TEST_PASSWORD,
      });
      const client = await connectClient(provider);
      const result = await client.callTool({
        name: 'get_current_user',
        arguments: {},
      });
      expect(result.structuredContent).toEqual({
        id: admin.id,
        email: admin.email,
        roles: ['platform_admin'],
      });
    });

    it('identifies a user with no role as having none', async () => {
      const client = await connectClient(
        await connectWithOAuth(harness.endpoint, credentials()),
      );
      const result = await client.callTool({
        name: 'get_current_user',
        arguments: {},
      });
      expect(result.structuredContent).toEqual({
        id: user.id,
        email: user.email,
        roles: [],
      });
    });

    it('accepts the username as the sign-in identifier', async () => {
      const named = await createUser(app, { email: 'named@example.com' });
      await app.get(PrismaService).user.update({
        where: { id: named.id },
        data: { username: 'named-user' },
      });
      const provider = await connectWithOAuth(harness.endpoint, {
        identifier: 'named-user',
        password: TEST_PASSWORD,
      });
      const client = await connectClient(provider);
      const result = await client.callTool({
        name: 'get_current_user',
        arguments: {},
      });
      expect(result.structuredContent).toMatchObject({ id: named.id });
    });

    it('renews access with a rotating refresh token', async () => {
      const provider = await connectWithOAuth(harness.endpoint, credentials());
      const first = provider.tokens()!;
      const clientId = provider.clientInformation()!.client_id;
      const renewed = await refresh({
        refresh_token: first.refresh_token!,
        client_id: clientId,
      }).expect(200);
      await callMcp(renewed.body.access_token as string).expect(200);
      expect(renewed.body.refresh_token).not.toBe(first.refresh_token);
      // The used refresh token is spent: reusing it fails.
      await refresh({
        refresh_token: first.refresh_token!,
        client_id: clientId,
      }).expect(400);
    });
  });

  describe('n8n MCP OAuth2 credential shape (AC2)', () => {
    it('registers without a client id, signs in with PKCE and resource, and refreshes', async () => {
      const registered = await registerClient({
        client_name: 'n8n',
        redirect_uris: [N8N_CALLBACK],
        response_types: ['code'],
        scope: 'mcp:use',
      }).expect(201);
      expect(registered.body).toMatchObject({
        client_name: 'n8n',
        redirect_uris: [N8N_CALLBACK],
        token_endpoint_auth_method: 'none',
      });
      expect(registered.body.client_secret).toBeUndefined();
      const clientId = registered.body.client_id as string;

      const { callback, verifier } = await signInRaw(clientId, N8N_CALLBACK);
      expect(callback.origin + callback.pathname).toBe(N8N_CALLBACK);
      expect(callback.searchParams.get('state')).toBe('state-123');
      const tokens = await exchangeCode({
        code: callback.searchParams.get('code')!,
        redirect_uri: N8N_CALLBACK,
        client_id: clientId,
        code_verifier: verifier,
        resource: harness.endpoint.toString(),
      }).expect(200);
      expect(tokens.body).toMatchObject({
        token_type: 'Bearer',
        scope: 'mcp:use',
      });
      expect(tokens.body.refresh_token).toEqual(expect.any(String));
      await callMcp(tokens.body.access_token as string).expect(200);

      await refresh({
        refresh_token: tokens.body.refresh_token,
        client_id: clientId,
        resource: harness.endpoint.toString(),
      }).expect(200);
    });
  });

  describe('refusals leave the client unconnected (S4a, AC3)', () => {
    let clientId: string;

    beforeEach(async () => {
      const registered = await registerClient({
        client_name: 'Refusal client',
        redirect_uris: [LOOPBACK_REDIRECT],
      }).expect(201);
      clientId = registered.body.client_id;
    });

    it('declining consent sends access_denied and no code', async () => {
      const { callback } = await signInRaw(clientId, LOOPBACK_REDIRECT, 'deny');
      expect(callback.searchParams.get('error')).toBe('access_denied');
      expect(callback.searchParams.get('code')).toBeNull();
    });

    it('cancelling on the sign-in page sends access_denied', async () => {
      const browser = new OAuthBrowser();
      const page = await browser.follow(
        authorizationUrl(clientId, LOOPBACK_REDIRECT, pkcePair().challenge),
      );
      const html = await page.response!.text();
      const cancel = readForm(html, '/abort');
      const done = await browser.follow(`${harness.baseUrl}${cancel.action}`, {
        form: { formToken: cancel.formToken },
      });
      expect(new URL(done.url).searchParams.get('error')).toBe('access_denied');
    });

    async function attemptSignIn(identifier: string, password: string) {
      const browser = new OAuthBrowser();
      const page = await browser.follow(
        authorizationUrl(clientId, LOOPBACK_REDIRECT, pkcePair().challenge),
      );
      const login = readForm(await page.response!.text(), '/login');
      return browser.request(`${harness.baseUrl}${login.action}`, {
        form: { identifier, password, formToken: login.formToken },
      });
    }

    it.each([
      ['a wrong password', () => user.email, 'not-the-password-1'],
      ['an unknown account', () => 'nobody@example.com', TEST_PASSWORD],
    ])(
      '%s is refused on the page, without saying which',
      async (_, identifier, password) => {
        const response = await attemptSignIn(identifier(), password);
        expect(response.status).toBe(400);
        expect(response.headers.get('location')).toBeNull();
        expect(await response.text()).toContain(
          'That email or username and password do not match.',
        );
      },
    );

    it('an inactive account answers exactly as a wrong password does', async () => {
      await app.get(PrismaService).user.update({
        where: { id: user.id },
        data: { isActive: false },
      });
      const response = await attemptSignIn(user.email, TEST_PASSWORD);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        'That email or username and password do not match.',
      );
    });

    it('an unverified account cannot sign in', async () => {
      await app.get(PrismaService).user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: null },
      });
      const response = await attemptSignIn(user.email, TEST_PASSWORD);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('Verify your email address');
    });
  });

  describe('protocol rules', () => {
    let clientId: string;

    beforeEach(async () => {
      const registered = await registerClient({
        client_name: 'Protocol client',
        redirect_uris: [LOOPBACK_REDIRECT],
      }).expect(201);
      clientId = registered.body.client_id;
    });

    it.each([
      ['plain http to a public host', 'http://n8n.example.com/callback'],
      ['a custom scheme', 'cursor://callback'],
      ['a fragment', 'https://claude.ai/callback#x'],
    ])('refuses to register %s as a redirect', async (_, redirectUri) => {
      const response = await registerClient({
        client_name: 'Bad',
        redirect_uris: [redirectUri],
      }).expect(400);
      expect(response.body.error).toBe('invalid_redirect_uri');
    });

    it('refuses a client that asks to authenticate with a secret', async () => {
      await registerClient({
        client_name: 'Confidential',
        redirect_uris: [LOOPBACK_REDIRECT],
        token_endpoint_auth_method: 'client_secret_basic',
      }).expect(400);
    });

    it('accepts a loopback redirect on a different port, as Claude Code uses', async () => {
      const otherPort = 'http://localhost:4321/callback';
      const { callback } = await signInRaw(clientId, otherPort);
      expect(callback.origin).toBe('http://localhost:4321');
      expect(callback.searchParams.get('code')).toEqual(expect.any(String));
    });

    it('refuses an unregistered https redirect without redirecting to it', async () => {
      const response = await request(app.getHttpServer()).get(
        new URL(
          authorizationUrl(
            clientId,
            'https://evil.example/callback',
            pkcePair().challenge,
          ),
        ).pathname +
          new URL(
            authorizationUrl(
              clientId,
              'https://evil.example/callback',
              pkcePair().challenge,
            ),
          ).search,
      );
      expect(response.status).toBe(400);
      expect(response.headers.location).toBeUndefined();
    });

    it('refuses PKCE plain and a missing code challenge', async () => {
      const { challenge } = pkcePair();
      const variants: Record<string, string>[] = [
        { code_challenge_method: 'plain' },
        { code_challenge: '' },
      ];
      for (const extra of variants) {
        const url = new URL(
          authorizationUrl(clientId, LOOPBACK_REDIRECT, challenge, extra),
        );
        const response = await request(app.getHttpServer()).get(
          url.pathname + url.search,
        );
        const location = new URL(response.headers.location as string);
        expect(location.searchParams.get('error')).toBe('invalid_request');
      }
    });

    it('refuses a resource other than this MCP endpoint', async () => {
      const url = new URL(
        authorizationUrl(clientId, LOOPBACK_REDIRECT, pkcePair().challenge, {
          resource: 'https://other.example.com/mcp',
        }),
      );
      const response = await request(app.getHttpServer()).get(
        url.pathname + url.search,
      );
      expect(
        new URL(response.headers.location as string).searchParams.get('error'),
      ).toBe('invalid_target');
    });

    it('refuses a wrong code verifier', async () => {
      const { callback, verifier } = await signInRaw(
        clientId,
        LOOPBACK_REDIRECT,
      );
      const code = callback.searchParams.get('code')!;
      const form = {
        code,
        redirect_uri: LOOPBACK_REDIRECT,
        client_id: clientId,
      };
      const wrong = await exchangeCode({
        ...form,
        code_verifier: pkcePair().verifier,
      });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error).toBe('invalid_grant');
      // Someone holding an intercepted code without the verifier cannot spend
      // it on the real client's behalf: the real client still redeems it.
      await exchangeCode({ ...form, code_verifier: verifier }).expect(200);
    });

    it('lets only one of two simultaneous redemptions of a code succeed', async () => {
      const { callback, verifier } = await signInRaw(
        clientId,
        LOOPBACK_REDIRECT,
      );
      const form = {
        code: callback.searchParams.get('code')!,
        redirect_uri: LOOPBACK_REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
      };
      const results = await Promise.all([
        exchangeCode(form),
        exchangeCode(form),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    });

    it('lets only one of two simultaneous refreshes with one refresh token succeed', async () => {
      const provider = await connectWithOAuth(harness.endpoint, credentials());
      const form = {
        refresh_token: provider.tokens()!.refresh_token!,
        client_id: provider.clientInformation()!.client_id,
      };
      const results = await Promise.all([refresh(form), refresh(form)]);
      expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    });

    it('refuses more than 10 redirect URIs and an over-long client name', async () => {
      const uris = Array.from(
        { length: 11 },
        (_, index) => `http://localhost:${9000 + index}/cb`,
      );
      await registerClient({ client_name: 'Many', redirect_uris: uris }).expect(
        400,
      );
      const named = await registerClient({
        client_name: 'x'.repeat(256),
        redirect_uris: [LOOPBACK_REDIRECT],
      }).expect(400);
      expect(named.body.error).toBe('invalid_client_metadata');
    });

    it('drops metadata that would make the server fetch a URL', async () => {
      const fetchSpy = jest.spyOn(globalThis, 'fetch');
      try {
        const registered = await registerClient({
          client_name: 'Fetcher',
          redirect_uris: [LOOPBACK_REDIRECT],
          sector_identifier_uri: 'https://attacker.example/sectors.json',
          jwks_uri: 'https://attacker.example/jwks.json',
          logo_uri: 'https://attacker.example/logo.png',
        }).expect(201);
        expect(registered.body.sector_identifier_uri).toBeUndefined();
        expect(registered.body.jwks_uri).toBeUndefined();
        const outbound = fetchSpy.mock.calls.filter(([input]) =>
          String(input instanceof Request ? input.url : input).includes(
            'attacker.example',
          ),
        );
        expect(outbound).toEqual([]);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('a redeemed code cannot be redeemed again', async () => {
      const { callback, verifier } = await signInRaw(
        clientId,
        LOOPBACK_REDIRECT,
      );
      const form = {
        code: callback.searchParams.get('code')!,
        redirect_uri: LOOPBACK_REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
      };
      const first = await exchangeCode(form).expect(200);
      const second = await exchangeCode(form).expect(400);
      expect(second.body.error).toBe('invalid_grant');
      // Replay revokes what the code produced.
      await callMcp(first.body.access_token as string).expect(401);
    });
  });

  describe('MCP and REST tokens are not interchangeable (AC6)', () => {
    it('an MCP token is refused by the REST API', async () => {
      const provider = await connectWithOAuth(harness.endpoint, credentials());
      await request(app.getHttpServer())
        .get('/api/users/me')
        .set('Authorization', `Bearer ${provider.tokens()!.access_token}`)
        .expect(401);
    });

    it('a REST login token is refused by MCP', async () => {
      const restToken = await issueAccessToken(app, user.id);
      await request(app.getHttpServer())
        .get('/api/users/me')
        .set('Authorization', `Bearer ${restToken}`)
        .expect(200);
      const response = await callMcp(restToken).expect(401);
      expect(response.body).toMatchObject({ errorCode: 'TOKEN_INVALID' });
    });
  });

  describe('access ends at the next request (S7, S7a, AC5)', () => {
    let accessToken: string;
    let refreshToken: string;
    let clientId: string;

    beforeEach(async () => {
      const provider = await connectWithOAuth(harness.endpoint, credentials());
      accessToken = provider.tokens()!.access_token;
      refreshToken = provider.tokens()!.refresh_token!;
      clientId = provider.clientInformation()!.client_id;
      await callMcp(accessToken).expect(200);
    });

    async function expectAccessEnded(): Promise<void> {
      const response = await callMcp(accessToken).expect(401);
      // The refused client is pointed back at sign-in (S7a → S2).
      expect(response.headers['www-authenticate']).toContain(
        'resource_metadata=',
      );
      const renewed = await refresh({
        refresh_token: refreshToken,
        client_id: clientId,
      });
      expect(renewed.status).toBe(400);
      expect(renewed.body.error).toBe('invalid_grant');
    }

    // Logout-all and credential changes round the cutoff UP to the next whole
    // second (`nextWholeSecond`); a token minted in the same second as the
    // change must not survive it. Waiting out the second keeps the test from
    // depending on where in a second it happened to run.
    const waitForNextSecond = () =>
      new Promise((resolve) => setTimeout(resolve, 1100 - (Date.now() % 1000)));

    it('after sign-out everywhere', async () => {
      const restToken = await issueAccessToken(app, user.id);
      await request(app.getHttpServer())
        .post('/api/auth/logout-all')
        .set('Authorization', `Bearer ${restToken}`)
        .expect(204);
      await expectAccessEnded();
    });

    it('after the user changes their password', async () => {
      const restToken = await issueAccessToken(app, user.id);
      await request(app.getHttpServer())
        .patch('/api/users/me/password')
        .set('Authorization', `Bearer ${restToken}`)
        .send({
          currentPassword: TEST_PASSWORD,
          newPassword: 'a-new-Passw0rd-entirely',
        })
        .expect(200);
      await expectAccessEnded();
    });

    it('after an administrator resets the password', async () => {
      const admin = await createPlatformAdmin(app);
      await request(app.getHttpServer())
        .patch(`/api/users/${user.id}/password`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ newPassword: 'a-new-Passw0rd-entirely' })
        .expect(200);
      await expectAccessEnded();
    });

    it('after the user is deactivated', async () => {
      const admin = await createPlatformAdmin(app);
      await request(app.getHttpServer())
        .patch(`/api/users/${user.id}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ isActive: false })
        .expect(200);
      await expectAccessEnded();
    });

    it('after the account is deleted', async () => {
      const admin = await createPlatformAdmin(app);
      await request(app.getHttpServer())
        .delete(`/api/users/${user.id}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(204);
      await expectAccessEnded();
    });

    it('when the access token expires', async () => {
      await app.get(PrismaService).oAuthPayload.updateMany({
        where: { model: 'AccessToken' },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await callMcp(accessToken).expect(401);
    });

    it('does not let a token minted before the cutoff back in, even after the next second', async () => {
      const restToken = await issueAccessToken(app, user.id);
      await request(app.getHttpServer())
        .post('/api/auth/logout-all')
        .set('Authorization', `Bearer ${restToken}`)
        .expect(204);
      await waitForNextSecond();
      await callMcp(accessToken).expect(401);
    });

    it('a sign-in code issued before sign-out everywhere cannot be redeemed after it', async () => {
      const registered = await registerClient({
        client_name: 'Late redeemer',
        redirect_uris: [LOOPBACK_REDIRECT],
      }).expect(201);
      const { callback, verifier } = await signInRaw(
        registered.body.client_id as string,
        LOOPBACK_REDIRECT,
      );
      await waitForNextSecond();
      const restToken = await issueAccessToken(app, user.id);
      await request(app.getHttpServer())
        .post('/api/auth/logout-all')
        .set('Authorization', `Bearer ${restToken}`)
        .expect(204);
      const response = await exchangeCode({
        code: callback.searchParams.get('code')!,
        redirect_uri: LOOPBACK_REDIRECT,
        client_id: registered.body.client_id,
        code_verifier: verifier,
      });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_grant');
    });

    // A sign-in held open on the consent page across the revocation: the
    // revocation is aimed at exactly that person, so approving must not mint
    // anything usable.
    it.each([
      [
        'sign-out everywhere',
        async () => {
          const restToken = await issueAccessToken(app, user.id);
          await request(app.getHttpServer())
            .post('/api/auth/logout-all')
            .set('Authorization', `Bearer ${restToken}`)
            .expect(204);
        },
      ],
      [
        'a password change',
        async () => {
          const restToken = await issueAccessToken(app, user.id);
          await request(app.getHttpServer())
            .patch('/api/users/me/password')
            .set('Authorization', `Bearer ${restToken}`)
            .send({
              currentPassword: TEST_PASSWORD,
              newPassword: 'a-new-Passw0rd-entirely',
            })
            .expect(200);
        },
      ],
    ])(
      'a sign-in left on the consent page across %s cannot be approved',
      async (_, revoke) => {
        const registered = await registerClient({
          client_name: 'Held open',
          redirect_uris: [LOOPBACK_REDIRECT],
        }).expect(201);
        const clientId = registered.body.client_id as string;
        const browser = new OAuthBrowser();
        const page = await browser.follow(
          authorizationUrl(clientId, LOOPBACK_REDIRECT, pkcePair().challenge),
        );
        const login = readForm(await page.response!.text(), '/login');
        const consent = await browser.follow(
          `${harness.baseUrl}${login.action}`,
          { form: { ...credentials(), formToken: login.formToken } },
        );
        const consentForm = readForm(
          await consent.response!.text(),
          '/confirm',
        );

        await waitForNextSecond();
        await revoke();

        const done = await browser.follow(
          `${harness.baseUrl}${consentForm.action}`,
          { form: { decision: 'approve', formToken: consentForm.formToken } },
        );
        expect(done.response).toBeUndefined();
        const callback = new URL(done.url);
        expect(callback.searchParams.get('error')).toBe('access_denied');
        expect(callback.searchParams.get('code')).toBeNull();
      },
    );

    it('signing in again restores access with a new token (S7a → S2)', async () => {
      const restToken = await issueAccessToken(app, user.id);
      await request(app.getHttpServer())
        .post('/api/auth/logout-all')
        .set('Authorization', `Bearer ${restToken}`)
        .expect(204);
      await waitForNextSecond();
      const provider = await connectWithOAuth(harness.endpoint, credentials());
      await callMcp(provider.tokens()!.access_token).expect(200);
    });
  });

  describe('the sign-in and consent pages (AC7)', () => {
    let clientId: string;
    const hostileName = '<script>alert("x")</script>';

    beforeEach(async () => {
      const registered = await registerClient({
        client_name: hostileName,
        redirect_uris: [N8N_CALLBACK],
      }).expect(201);
      clientId = registered.body.client_id;
    });

    async function openLoginPage(browser = new OAuthBrowser()) {
      const page = await browser.follow(
        authorizationUrl(clientId, N8N_CALLBACK, pkcePair().challenge),
      );
      return {
        browser,
        response: page.response!,
        html: await page.response!.text(),
      };
    }

    it('cannot be framed and allows no outside script or style', async () => {
      const { response } = await openLoginPage();
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      const csp = response.headers.get('content-security-policy')!;
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'none'");
      // The consent post ends at the client: its origin is allowed, no other.
      expect(csp).toContain("form-action 'self' https://n8n.example.com");
      expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it('escapes the client name a registering client chose', async () => {
      const { html } = await openLoginPage();
      expect(html).not.toContain(hostileName);
      expect(html).toContain('&lt;script&gt;');
    });

    it('shows the client name and its registered redirect URL on the consent page', async () => {
      const { browser, html } = await openLoginPage();
      const login = readForm(html, '/login');
      const consent = await browser.follow(
        `${harness.baseUrl}${login.action}`,
        {
          form: { ...credentials(), formToken: login.formToken },
        },
      );
      const consentHtml = await consent.response!.text();
      expect(consentHtml).toContain(N8N_CALLBACK);
      expect(consentHtml).toContain(
        '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
      );
      expect(consentHtml).toContain(user.email);
      expect(consent.response!.headers.get('x-frame-options')).toBe('DENY');
    });

    it('refuses a sign-in post without the form token', async () => {
      const { browser, html } = await openLoginPage();
      const login = readForm(html, '/login');
      const response = await browser.request(
        `${harness.baseUrl}${login.action}`,
        {
          form: { ...credentials(), formToken: 'forged' },
        },
      );
      expect(response.status).toBe(403);
      expect(response.headers.get('location')).toBeNull();
    });

    it('refuses a post from a browser that did not start the sign-in (cross-site forgery)', async () => {
      const { html } = await openLoginPage();
      const login = readForm(html, '/login');
      // A different browser — no interaction cookie — even with the right token.
      const response = await new OAuthBrowser().request(
        `${harness.baseUrl}${login.action}`,
        {
          form: { ...credentials(), formToken: login.formToken },
        },
      );
      expect(response.status).toBe(400);
      expect(response.headers.get('location')).toBeNull();
    });

    it('refuses a consent post without the form token', async () => {
      const { browser, html } = await openLoginPage();
      const login = readForm(html, '/login');
      const consent = await browser.follow(
        `${harness.baseUrl}${login.action}`,
        {
          form: { ...credentials(), formToken: login.formToken },
        },
      );
      const consentForm = readForm(await consent.response!.text(), '/confirm');
      const response = await browser.request(
        `${harness.baseUrl}${consentForm.action}`,
        {
          form: { decision: 'approve' },
        },
      );
      expect(response.status).toBe(403);
    });

    it('asks for the password again on the next authorization in the same browser', async () => {
      const { browser, html } = await openLoginPage();
      const login = readForm(html, '/login');
      const consent = await browser.follow(
        `${harness.baseUrl}${login.action}`,
        {
          form: { ...credentials(), formToken: login.formToken },
        },
      );
      const consentForm = readForm(await consent.response!.text(), '/confirm');
      await browser.follow(`${harness.baseUrl}${consentForm.action}`, {
        form: { decision: 'approve', formToken: consentForm.formToken },
      });
      const again = await openLoginPage(browser);
      expect(again.html).toMatch(/name=["']password["']/);
    });
  });
});

// The sign-in form with the Turnstile bot check on (both secrets and the web
// site key set — the staging and production shape). Siteverify is stubbed at
// `fetch`, as in turnstile.e2e-spec.ts.
describe('MCP OAuth sign-in with the bot check on (e2e)', () => {
  const SITEVERIFY_URL =
    'https://challenges.cloudflare.com/turnstile/v0/siteverify';
  const PASS = 'genuine-widget-token';
  const SITE_KEY = 'e2e-web-widget-site-key';
  const realFetch = globalThis.fetch;
  let harness: OAuthTestApp;
  let fetchSpy: jest.SpyInstance;
  let user: SeededUser;
  let clientId: string;

  beforeAll(async () => {
    harness = await createOAuthTestApp({
      TURNSTILE_WEB_SECRET: 'e2e-web-widget-secret',
      TURNSTILE_MOBILE_SECRET: 'e2e-mobile-widget-secret',
      TURNSTILE_WEB_SITE_KEY: SITE_KEY,
    });
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url !== SITEVERIFY_URL) return realFetch(input, init);
        const form = init?.body as URLSearchParams;
        return Promise.resolve(
          new Response(
            JSON.stringify({ success: form.get('response') === PASS }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      });
  });

  afterAll(async () => {
    fetchSpy.mockRestore();
    await harness.app.close();
    harness.restore();
  });

  beforeEach(async () => {
    await truncateAll(harness.app);
    await seedRbacCatalog(harness.app);
    user = await createRegularUser(harness.app, 'bot-check@example.com');
    const registered = await request(harness.app.getHttpServer())
      .post('/oauth/register')
      .send({
        client_name: 'Bot check client',
        redirect_uris: [LOOPBACK_REDIRECT],
      })
      .expect(201);
    clientId = registered.body.client_id as string;
  });

  async function openLogin() {
    const browser = new OAuthBrowser();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: LOOPBACK_REDIRECT,
      code_challenge: pkcePair().challenge,
      code_challenge_method: 'S256',
      scope: 'mcp:use',
    });
    const page = await browser.follow(
      `${harness.baseUrl}/oauth/authorize?${query.toString()}`,
    );
    return {
      browser,
      response: page.response!,
      html: await page.response!.text(),
    };
  }

  it('renders the widget, allowing only its script', async () => {
    const { response, html } = await openLogin();
    expect(html).toMatch(new RegExp(`data-sitekey=["']${SITE_KEY}["']`));
    expect(response.headers.get('content-security-policy')).toContain(
      'https://challenges.cloudflare.com',
    );
  });

  it('refuses a sign-in without a widget token, before checking the password', async () => {
    const { browser, html } = await openLogin();
    const login = readForm(html, '/login');
    const response = await browser.request(
      `${harness.baseUrl}${login.action}`,
      {
        form: {
          identifier: user.email,
          password: TEST_PASSWORD,
          formToken: login.formToken,
        },
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      errorCode: 'TURNSTILE_TOKEN_MISSING',
    });
  });

  it('signs in with the token the widget put in the form', async () => {
    const { browser, html } = await openLogin();
    const login = readForm(html, '/login');
    const consent = await browser.follow(`${harness.baseUrl}${login.action}`, {
      form: {
        identifier: user.email,
        password: TEST_PASSWORD,
        formToken: login.formToken,
        'cf-turnstile-response': PASS,
      },
    });
    expect(await consent.response!.text()).toContain('Allow access?');
  });
});

// The bot check on but no web site key: an upgrade that has not added it yet.
// The app boots; only the sign-in page refuses, rather than offering a form
// whose post could never pass the check.
describe('MCP OAuth sign-in with the bot check on and no site key (e2e)', () => {
  let harness: OAuthTestApp;

  beforeAll(async () => {
    harness = await createOAuthTestApp({
      TURNSTILE_WEB_SECRET: 'e2e-web-widget-secret',
      TURNSTILE_MOBILE_SECRET: 'e2e-mobile-widget-secret',
      TURNSTILE_WEB_SITE_KEY: '',
    });
  });

  afterAll(async () => {
    await harness.app.close();
    harness.restore();
  });

  it('boots, and the sign-in page answers 503 instead of a form', async () => {
    const registered = await request(harness.app.getHttpServer())
      .post('/oauth/register')
      .send({ client_name: 'No site key', redirect_uris: [LOOPBACK_REDIRECT] })
      .expect(201);
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: registered.body.client_id as string,
      redirect_uri: LOOPBACK_REDIRECT,
      code_challenge: pkcePair().challenge,
      code_challenge_method: 'S256',
      scope: 'mcp:use',
    });
    const page = await new OAuthBrowser().follow(
      `${harness.baseUrl}/oauth/authorize?${query.toString()}`,
    );
    expect(page.response!.status).toBe(503);
    const html = await page.response!.text();
    expect(html).toContain('Sign-in unavailable');
    expect(html).not.toMatch(/name=["']password["']/);
  });
});
