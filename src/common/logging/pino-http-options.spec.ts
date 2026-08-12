import {
  createServer,
  get,
  type IncomingMessage,
  type ServerResponse,
} from 'http';
import { PassThrough } from 'stream';
import pinoHttp from 'pino-http';
import { buildPinoHttpOptions, buildRedactPaths } from './pino-http-options';

// This spec exists because the redaction it guards was INERT for the entire
// life of the repository and nothing noticed.
//
// The paths were written `request.headers.authorization` / `response.headers…`
// while pino-http logs under `req` / `res`, so every path matched nothing and
// `Authorization` and `Cookie` went to stdout in clear on every logged request.
// The configuration looked correct, a code comment said "Auth headers are
// redacted from logs", and the repository documentation repeated it.
//
// So this asserts on the BYTES pino actually emits, driving the real options
// object through a real pino-http instance over a real HTTP request. Anything
// weaker — inspecting the path list, trusting the prefix — is what let the
// original defect survive review.
describe('pino-http options', () => {
  const AUTHORIZATION_SECRET = 'Bearer aaaa-authorization-secret';
  const REQUEST_COOKIE_SECRET = 'session=bbbb-request-cookie-secret';
  const API_KEY_SECRET = 'cccc-api-key-secret';
  const PROXY_AUTHORIZATION_SECRET = 'Basic dddd-proxy-authorization-secret';
  const RESPONSE_COOKIE_SECRET = 'session=eeee-response-cookie-secret';
  const QUERY_TOKEN_SECRET = 'ffff-query-token-secret';

  // Boots a throwaway HTTP server wired to the real options, issues one request
  // carrying every credential shape the API can receive, and returns the raw
  // log output.
  async function captureLogOutput(): Promise<string> {
    const sink = new PassThrough();
    let output = '';
    sink.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    // `isTest: false` deliberately — the test environment sets `level: 'silent'`,
    // which would emit nothing and make every assertion below vacuously true.
    const options = buildPinoHttpOptions({ isProduction: true, isTest: false });
    const logRequest = pinoHttp(options as never, sink);

    const server = createServer(
      (request: IncomingMessage, response: ServerResponse) => {
        logRequest(request, response);
        response.setHeader('set-cookie', RESPONSE_COOKIE_SECRET);
        response.end('ok');
      },
    );

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    await new Promise<void>((resolve) => {
      get(
        {
          port,
          host: '127.0.0.1',
          path: `/api/auth/verify-email?token=${QUERY_TOKEN_SECRET}&page=2`,
          headers: {
            authorization: AUTHORIZATION_SECRET,
            cookie: REQUEST_COOKIE_SECRET,
            'x-api-key': API_KEY_SECRET,
            'proxy-authorization': PROXY_AUTHORIZATION_SECRET,
          },
        },
        (response) => {
          response.resume();
          response.on('end', () => setTimeout(resolve, 50));
        },
      );
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));
    return output;
  }

  let logOutput: string;

  beforeAll(async () => {
    logOutput = await captureLogOutput();
  });

  // Guards the guard: an empty capture would make every assertion below pass
  // for the wrong reason — which is precisely how the original defect hid.
  it('actually emits a log line', () => {
    expect(logOutput.length).toBeGreaterThan(0);
    expect(logOutput).toContain('/api/auth/verify-email');
  });

  it.each([
    ['Authorization header', AUTHORIZATION_SECRET],
    ['request Cookie header', REQUEST_COOKIE_SECRET],
    ['X-API-Key header', API_KEY_SECRET],
    ['Proxy-Authorization header', PROXY_AUTHORIZATION_SECRET],
    ['response Set-Cookie header', RESPONSE_COOKIE_SECRET],
    ['query-string token', QUERY_TOKEN_SECRET],
  ])('never writes the %s to the log', (_label, secret) => {
    expect(logOutput).not.toContain(secret);
  });

  it('censors rather than silently dropping', () => {
    expect(logOutput).toContain('[redacted]');
  });

  // The access log has to stay useful, or the "fix" is just deleting the logs.
  it('keeps the path and non-secret query parameters', () => {
    expect(logOutput).toContain('/api/auth/verify-email');
    expect(logOutput).toContain('page');
  });

  describe('redact paths', () => {
    // The exact defect: a `request.`/`response.` prefix matches nothing,
    // because pino-http logs under `req`/`res`.
    it('addresses pino-http’s real log keys', () => {
      for (const path of buildRedactPaths()) {
        expect(path.startsWith('req.') || path.startsWith('res.')).toBe(true);
      }
    });

    it('declares no request-body path, which pino-http never serializes', () => {
      expect(
        buildRedactPaths().filter((path) => path.includes('.body.')),
      ).toEqual([]);
    });
  });
});
