import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import {
  auth,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { createTestApp } from './test-app';

// Helpers for driving the MCP OAuth authorization server (src/modules/mcp-oauth)
// the way a real client and a real browser do: the official MCP client SDK
// runs discovery, registration, PKCE and the token exchange; `OAuthBrowser`
// plays the user, following redirects with a cookie jar and submitting the
// server-rendered sign-in and consent forms.

export const MCP_PATH = '/api/mcp';

/** A free TCP port, so the app's URL — its OAuth issuer — is known up front. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('no port'));
      });
    });
  });
}

export interface OAuthTestApp {
  app: INestApplication<App>;
  baseUrl: string;
  endpoint: URL;
  restore: () => void;
}

/**
 * Boots the app on a known port with API_BASE_URL pointing at it, so the
 * issuer and the protected resource match the URL clients connect to.
 */
export async function createOAuthTestApp(
  env: Record<string, string> = {},
): Promise<OAuthTestApp> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const values = { API_BASE_URL: `${baseUrl}/api`, ...env };
  const original = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, values);
  const app = (await createTestApp(undefined, {
    port,
  })) as INestApplication<App>;
  return {
    app,
    baseUrl,
    endpoint: new URL(`${baseUrl}${MCP_PATH}`),
    restore: () => {
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

/** A browser: a cookie jar and manual redirect following. */
export class OAuthBrowser {
  private readonly cookies = new Map<string, string>();

  async request(
    url: string,
    init: {
      method?: string;
      form?: Record<string, string>;
      origin?: string;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies]
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
    }
    let body: string | undefined;
    if (init.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(init.form).toString();
      // A browser sends Origin with every form POST.
      headers.origin = init.origin ?? new URL(url).origin;
    }
    const response = await fetch(url, {
      method: init.method ?? (init.form ? 'POST' : 'GET'),
      headers,
      body,
      redirect: 'manual',
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0] ?? '';
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (/expires=Thu, 01 Jan 1970/i.test(cookie) || value === '') {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
    return response;
  }

  /**
   * Follows redirects on this origin until a page answers or the browser is
   * sent elsewhere (the client's redirect URI). Returns the final response
   * and the URL it was fetched from — or, when sent away, the URL it was sent
   * to, unfetched.
   */
  async follow(
    url: string,
    init: { method?: string; form?: Record<string, string> } = {},
  ): Promise<{ response?: Response; url: string }> {
    let current = url;
    let response = await this.request(current, init);
    for (let hop = 0; hop < 10; hop += 1) {
      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || !location) {
        return { response, url: current };
      }
      const next = new URL(location, current);
      if (next.origin !== new URL(url).origin) {
        return { url: next.toString() };
      }
      current = next.toString();
      response = await this.request(current);
    }
    throw new Error('too many redirects');
  }
}

/** The form fields on a server-rendered page: `action` and hidden inputs. */
export function readForm(
  html: string,
  actionSuffix: string,
): { action: string; formToken: string } {
  const forms = [
    ...html.matchAll(
      /<form\s[^>]*action=["']([^"']+)["'][^>]*>[\s\S]*?<\/form>/g,
    ),
  ];
  const form = forms.find((match) => match[1]?.endsWith(actionSuffix));
  const action = form?.[1];
  if (!form || !action) throw new Error(`no form ending in ${actionSuffix}`);
  const token = /name=["']formToken["']\s+value=["']([^"']+)["']/.exec(
    form[0],
  )?.[1];
  if (!token) throw new Error('no form token');
  return { action, formToken: token };
}

export interface Credentials {
  identifier: string;
  password: string;
}

export type ConsentDecision = 'approve' | 'deny';

/**
 * Plays the user from the authorization URL to the client's redirect: signs
 * in, then approves or denies. Returns the redirect URL the browser was sent
 * to, carrying `code` or `error`.
 */
export async function completeBrowserSignIn(
  browser: OAuthBrowser,
  authorizationUrl: string,
  credentials: Credentials,
  decision: ConsentDecision = 'approve',
): Promise<URL> {
  const origin = new URL(authorizationUrl).origin;
  const loginPage = await browser.follow(authorizationUrl);
  if (!loginPage.response) throw new Error(`sent away early: ${loginPage.url}`);
  const loginHtml = await loginPage.response.text();
  const login = readForm(loginHtml, '/login');
  const consentPage = await browser.follow(`${origin}${login.action}`, {
    form: { ...credentials, formToken: login.formToken },
  });
  if (!consentPage.response) return new URL(consentPage.url);
  const consentHtml = await consentPage.response.text();
  const consent = readForm(consentHtml, '/confirm');
  const done = await browser.follow(`${origin}${consent.action}`, {
    form: { decision, formToken: consent.formToken },
  });
  if (done.response) {
    throw new Error(`no redirect after consent: ${done.response.status}`);
  }
  return new URL(done.url);
}

export const LOOPBACK_REDIRECT = 'http://localhost:9876/callback';

/** An in-memory `OAuthClientProvider`, as an MCP host keeps per server. */
export class TestOAuthClientProvider implements OAuthClientProvider {
  authorizationUrl?: URL;
  private information?: StoredOAuthClientInformation;
  private storedTokens?: StoredOAuthTokens;
  private verifier = '';
  private discovery?: OAuthDiscoveryState;

  constructor(
    private readonly metadata: Partial<OAuthClientMetadata> = {},
    readonly redirect = LOOPBACK_REDIRECT,
  ) {}

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'MCP e2e client',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...this.metadata,
    };
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    return this.information;
  }

  saveClientInformation(information: StoredOAuthClientInformation): void {
    this.information = information;
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.storedTokens;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.storedTokens = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    return this.verifier;
  }

  // Lets the SDK check that the code is redeemed at the authorization server
  // the flow started with (its mix-up defence).
  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }
}

/**
 * The whole S1–S5 flow through the official client SDK: discovery,
 * registration, the browser sign-in and consent, and the code exchange.
 * Returns the provider holding the client's registration and tokens.
 */
export async function connectWithOAuth(
  endpoint: URL,
  credentials: Credentials,
  provider = new TestOAuthClientProvider(),
): Promise<TestOAuthClientProvider> {
  const started = await auth(provider, { serverUrl: endpoint });
  if (started !== 'REDIRECT' || !provider.authorizationUrl) {
    throw new Error(`expected a redirect to sign in, got ${started}`);
  }
  const callback = await completeBrowserSignIn(
    new OAuthBrowser(),
    provider.authorizationUrl.toString(),
    credentials,
  );
  const code = callback.searchParams.get('code');
  if (!code) throw new Error(`no code: ${callback.toString()}`);
  const finished = await auth(provider, {
    serverUrl: endpoint,
    authorizationCode: code,
    iss: callback.searchParams.get('iss') ?? undefined,
  });
  if (finished !== 'AUTHORIZED') throw new Error(`not authorized: ${finished}`);
  return provider;
}

/** PKCE S256 pair, for raw protocol requests that bypass the SDK. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
