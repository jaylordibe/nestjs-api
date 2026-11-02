import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INestApplication } from '@nestjs/common';
import {
  Client,
  ProtocolError,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { truncateAll } from './setup/db';
import {
  connectWithOAuth,
  createOAuthTestApp,
  MCP_PATH,
  type OAuthTestApp,
} from './setup/mcp-oauth';
import {
  createRegularUser,
  seedRbacCatalog,
  TEST_PASSWORD,
} from './setup/rbac';

// `/api/mcp` (src/modules/mcp). The protocol is driven through the official
// MCP client SDK in BOTH eras — the 2025 `initialize` handshake that n8n and
// most clients still speak, and the 2026-07-28 stateless protocol — so this
// exercises what a real client sees, not just hand-built HTTP. Raw requests
// cover what a client SDK refuses to send (missing auth, a browser Origin,
// malformed JSON-RPC).
//
// Clients authenticate with an access token from the MCP OAuth sign-in
// (test/setup/mcp-oauth.ts); that flow itself, and every way the token stops
// working, is covered in mcp-oauth.e2e-spec.ts.
//
// Not covered here: the endpoint's rate limit. The throttler is skipped under
// NODE_ENV=test for every route (app.module.ts), so it cannot be observed in
// e2e; the limit itself is a static value in mcp.config.ts.

const ALLOWED_ORIGIN = 'https://allowed.example.com';
const TOOL_NAMES = ['ping', 'echo', 'get_server_info', 'get_current_user'];

const newToken = (): string => randomBytes(32).toString('base64url');
const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const PACKAGE = JSON.parse(
  readFileSync(resolve(__dirname, '../package.json'), 'utf8'),
) as { name: string; version: string };

// The SDK answers 2025-era requests as a one-event SSE stream that closes after
// the result (2026-07-28 requests get plain JSON), so a
// raw legacy response is read from its `data:` line.
function readJsonRpc(response: request.Response): unknown {
  if (
    !String(response.headers['content-type']).startsWith('text/event-stream')
  ) {
    return response.body;
  }
  const dataLine = response.text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .pop();
  return dataLine ? JSON.parse(dataLine.slice('data:'.length)) : undefined;
}

const LEGACY_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

describe('MCP endpoint (e2e)', () => {
  let harness: OAuthTestApp;
  let app: INestApplication<App>;
  let endpoint: URL;
  let accessToken: string;
  const openClients: Client[] = [];

  async function signIn(email: string): Promise<string> {
    const user = await createRegularUser(app, email);
    const provider = await connectWithOAuth(endpoint, {
      identifier: user.email,
      password: TEST_PASSWORD,
    });
    const token = provider.tokens()?.access_token;
    if (!token) throw new Error('no access token');
    return token;
  }

  async function connectClient(
    token: string,
    era: 'legacy' | 'modern',
  ): Promise<Client> {
    const client = new Client(
      { name: 'mcp-e2e', version: '1.0.0' },
      era === 'modern'
        ? { versionNegotiation: { mode: { pin: '2026-07-28' } } }
        : {},
    );
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    openClients.push(client);
    return client;
  }

  beforeAll(async () => {
    // Before the module compiles: the config factory re-runs per AppModule.
    harness = await createOAuthTestApp({ MCP_ALLOWED_ORIGINS: ALLOWED_ORIGIN });
    app = harness.app;
    endpoint = harness.endpoint;
    await truncateAll(app);
    await seedRbacCatalog(app);
    accessToken = await signIn('mcp-endpoint@example.com');
  });

  afterAll(async () => {
    await Promise.all(openClients.map((client) => client.close()));
    await app.close();
    harness.restore();
  });

  describe.each(['legacy', 'modern'] as const)('%s-era client', (era) => {
    let client: Client;

    beforeAll(async () => {
      client = await connectClient(accessToken, era);
    });

    it('negotiates and identifies the server', () => {
      expect(client.getServerVersion()).toMatchObject({
        name: PACKAGE.name,
        version: PACKAGE.version,
      });
      // Truthful capabilities: the tool list never changes at runtime, so the
      // server must not invite clients to hold a list-changed stream open.
      expect(client.getServerCapabilities()?.tools?.listChanged).toBe(false);
      expect(client.getNegotiatedProtocolVersion()).toBe(
        era === 'modern' ? '2026-07-28' : '2025-11-25',
      );
    });

    it('discovers exactly the four tools, in a stable order, with schemas', async () => {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
      for (const tool of tools) {
        expect(tool.description).toEqual(expect.any(String));
        expect(tool.inputSchema).toMatchObject({ type: 'object' });
        expect(tool.outputSchema).toMatchObject({ type: 'object' });
        expect(tool.annotations).toMatchObject({
          readOnlyHint: true,
          idempotentHint: true,
        });
      }
      const echo = tools.find((tool) => tool.name === 'echo');
      expect(echo?.inputSchema).toMatchObject({
        required: ['message'],
        properties: { message: { type: 'string', maxLength: 1000 } },
      });
    });

    it('ping answers pong', async () => {
      const result = await client.callTool({ name: 'ping', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        success: true,
        message: 'pong',
      });
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify(result.structuredContent) },
      ]);
    });

    it('echo returns its message unchanged', async () => {
      const message = 'Hello MCP — ünïcødé ✓';
      const result = await client.callTool({
        name: 'echo',
        arguments: { message },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ success: true, message });
    });

    it('get_server_info identifies the application and nothing else', async () => {
      const result = await client.callTool({
        name: 'get_server_info',
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        name: PACKAGE.name,
        mcp: true,
        status: 'ready',
        version: PACKAGE.version,
      });
    });

    it.each([
      ['an empty message', { message: '' }],
      ['a whitespace-only message', { message: '   ' }],
      ['a message over 1000 characters', { message: 'x'.repeat(1001) }],
      ['a non-string message', { message: 42 }],
      ['no message', {}],
      ['an unknown argument', { message: 'hi', extra: true }],
    ])('echo rejects %s as a tool error', async (_, toolArguments) => {
      const result = await client.callTool({
        name: 'echo',
        arguments: toolArguments,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    });

    it('accepts a message of exactly 1000 characters', async () => {
      const message = 'x'.repeat(1000);
      const result = await client.callTool({
        name: 'echo',
        arguments: { message },
      });
      expect(result.structuredContent).toEqual({ success: true, message });
    });

    it('answers an unknown tool with a protocol error, not a crash', async () => {
      const call = client.callTool({ name: 'drop_database', arguments: {} });
      await expect(call).rejects.toBeInstanceOf(ProtocolError);
      await expect(call).rejects.toMatchObject({ code: -32602 });
      // The endpoint still serves afterwards.
      await expect(
        client.callTool({ name: 'ping', arguments: {} }),
      ).resolves.toMatchObject({ structuredContent: { message: 'pong' } });
    });

    it('serves concurrent calls independently', async () => {
      const messages = Array.from(
        { length: 25 },
        (_, index) => `message-${index}`,
      );
      const results = await Promise.all(
        messages.map((message) =>
          client.callTool({ name: 'echo', arguments: { message } }),
        ),
      );
      expect(results.map((result) => result.structuredContent)).toEqual(
        messages.map((message) => ({ success: true, message })),
      );
    });
  });

  it('accepts each signed-in client with its own token', async () => {
    const secondToken = await signIn('second-client@example.com');
    const client = await connectClient(secondToken, 'legacy');
    await expect(
      client.callTool({ name: 'ping', arguments: {} }),
    ).resolves.toMatchObject({ structuredContent: { message: 'pong' } });
  });

  describe('authentication', () => {
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'raw', version: '1.0.0' },
      },
    };

    it('refuses a request without a token: 401 + WWW-Authenticate', async () => {
      const response = await request(app.getHttpServer())
        .post(MCP_PATH)
        .set(LEGACY_HEADERS)
        .send(initialize)
        .expect(401);
      // Where to sign in (RFC 9728 §5.1): what starts a client's OAuth flow.
      expect(response.headers['www-authenticate']).toBe(
        `Bearer realm="mcp", resource_metadata="${harness.baseUrl}/.well-known/oauth-protected-resource/api/mcp", scope="mcp:use"`,
      );
      expect(response.body).toMatchObject({ errorCode: 'TOKEN_MISSING' });
    });

    it.each([
      ['an unknown token', () => `Bearer ${newToken()}`],
      // The database keys tokens by their SHA-256; that key is not a token.
      [
        'the stored digest of a valid token',
        () => `Bearer ${sha256(accessToken)}`,
      ],
      ['a truncated token', () => `Bearer ${accessToken.slice(0, -1)}`],
    ])('refuses %s: 401 invalid_token', async (_, authorization) => {
      const response = await request(app.getHttpServer())
        .post(MCP_PATH)
        .set(LEGACY_HEADERS)
        .set('Authorization', authorization())
        .send(initialize)
        .expect(401);
      expect(response.headers['www-authenticate']).toContain(
        'error="invalid_token"',
      );
      expect(response.body).toMatchObject({ errorCode: 'TOKEN_INVALID' });
    });

    it('refuses a non-Bearer scheme', async () => {
      await request(app.getHttpServer())
        .post(MCP_PATH)
        .set(LEGACY_HEADERS)
        .set(
          'Authorization',
          `Basic ${Buffer.from(`n8n:${accessToken}`).toString('base64')}`,
        )
        .send(initialize)
        .expect(401);
    });

    it('refuses every method, not just POST, without a token', async () => {
      await request(app.getHttpServer()).get(MCP_PATH).expect(401);
      await request(app.getHttpServer()).delete(MCP_PATH).expect(401);
    });

    it('refuses a tools/call without a token before executing it', async () => {
      const response = await request(app.getHttpServer())
        .post(MCP_PATH)
        .set(LEGACY_HEADERS)
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'ping', arguments: {} },
        })
        .expect(401);
      expect(JSON.stringify(response.body)).not.toContain('pong');
    });

    it('refuses a browser Origin that is not allowed, even with a valid token', async () => {
      const response = await request(app.getHttpServer())
        .post(MCP_PATH)
        .set(LEGACY_HEADERS)
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Origin', 'https://evil.example.com')
        .send(initialize)
        .expect(403);
      expect(response.body).toMatchObject({ errorCode: 'PERMISSION_DENIED' });
    });

    it('serves an allowed browser Origin', async () => {
      const response = await request(app.getHttpServer())
        .post(MCP_PATH)
        .set(LEGACY_HEADERS)
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Origin', ALLOWED_ORIGIN)
        .send(initialize)
        .expect(200);
      expect(readJsonRpc(response)).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: { serverInfo: { name: PACKAGE.name } },
      });
    });
  });

  it('closes a 2026-07-28 subscriptions/listen at once instead of holding a stream open', async () => {
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1.0.0' },
    };
    // `.timeout` fails the request if the server keeps the stream open.
    const response = await request(app.getHttpServer())
      .post(MCP_PATH)
      .timeout(3000)
      .set(LEGACY_HEADERS)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('MCP-Protocol-Version', '2026-07-28')
      .set('Mcp-Method', 'subscriptions/listen')
      .send({
        jsonrpc: '2.0',
        id: 9,
        method: 'subscriptions/listen',
        params: { _meta: meta, notifications: { toolsListChanged: true } },
      });
    expect(response.status).toBe(200);
    // The acknowledgement honours nothing: there is no list-changed feed.
    expect(response.text).toContain('"notifications":{}');
    // ...and the stream ends with the request's own final result.
    expect(response.text).toContain('"id":9');
    expect(response.text).toContain('"resultType":"complete"');
  });

  describe('protocol errors', () => {
    const post = () =>
      request(app.getHttpServer())
        .post(MCP_PATH)
        .set(LEGACY_HEADERS)
        .set('Authorization', `Bearer ${accessToken}`);

    it('answers malformed JSON with 400 and no stack trace', async () => {
      const response = await post().send('{"jsonrpc": "2.0", ').expect(400);
      expect(JSON.stringify(response.body)).not.toMatch(/at .*\.(js|ts):\d+/);
    });

    it('answers a body that is not JSON-RPC with a JSON-RPC error', async () => {
      const response = await post().send({ hello: 'world' });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(readJsonRpc(response)).toMatchObject({
        jsonrpc: '2.0',
        error: { code: expect.any(Number), message: expect.any(String) },
      });
    });

    it('answers an unknown method with JSON-RPC method-not-found', async () => {
      const response = await post().send({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/destroy',
        params: {},
      });
      expect(readJsonRpc(response)).toMatchObject({
        jsonrpc: '2.0',
        id: 7,
        error: { code: -32601 },
      });
    });
  });

  it('leaves the REST API unaffected', async () => {
    await request(app.getHttpServer()).get('/api/health/liveness').expect(200);
    // A user route still requires a user JWT; an MCP token is not one.
    await request(app.getHttpServer())
      .get('/api/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(401);
  });
});
