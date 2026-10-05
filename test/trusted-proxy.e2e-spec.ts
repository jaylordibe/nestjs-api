import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { truncateAll } from './setup/db';
import {
  createRegularUser,
  seedRbacCatalog,
  TEST_PASSWORD,
} from './setup/rbac';
import { createTestApp } from './setup/test-app';

// Who may choose `request.ip`.
//
// TRUST_PROXY lists the hops whose X-Forwarded-For Express believes. The
// address it resolves is the one rate limits key on, the one recorded against
// every refresh token, and the one in the audit envelope — so a forwarded
// address must count from a listed hop and from nowhere else. Each block boots
// the real application with its own TRUST_PROXY; supertest connects over
// loopback, so listing 127.0.0.1 makes the test client a trusted hop (the
// server-rendered topology, or Caddy) and listing anything else makes it an
// untrusted peer.
//
// No framework is involved: a server-rendered client forwarding the browser's
// address and user agent is, to the API, exactly these headers from a listed
// address.

const CLIENT_ADDRESS = '198.51.100.23';
const SPOOFED_ADDRESS = '203.0.113.66';
const USER_AGENT = 'TrustedProxyProbe/1.0';
const LOOPBACK_ADDRESSES = ['127.0.0.1', '::ffff:127.0.0.1', '::1'];

async function withEnvironment(
  overrides: Record<string, string>,
  boot: () => Promise<INestApplication<App>>,
): Promise<{ app: INestApplication<App>; restore: () => void }> {
  const original: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(overrides)) {
    original[name] = process.env[name];
    process.env[name] = value;
  }
  const restore = () => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  try {
    return { app: await boot(), restore };
  } catch (error) {
    restore();
    throw error;
  }
}

describe('Trusted proxy (e2e)', () => {
  const login = (
    app: INestApplication<App>,
    email: string,
    forwardedFor: string,
  ) =>
    request(app.getHttpServer())
      .post('/api/auth/login')
      .set('X-Forwarded-For', forwardedFor)
      .set('User-Agent', USER_AGENT)
      .send({ identifier: email, password: TEST_PASSWORD })
      .expect(200);

  // The session row the login just created — the fixture's own session was
  // started without a request, so it carries no user agent.
  const loginSession = (app: INestApplication<App>, userId: string) =>
    app.get(PrismaService).refreshToken.findFirstOrThrow({
      where: { userId, userAgent: USER_AGENT },
    });

  const registerAndReadAuditEnvelope = async (
    app: INestApplication<App>,
    headers: Record<string, string>,
  ): Promise<{ ip?: unknown; country?: unknown }> => {
    let pending = request(app.getHttpServer()).post('/api/auth/register');
    for (const [name, value] of Object.entries(headers)) {
      pending = pending.set(name, value);
    }
    await pending
      .send({
        email: 'audit-ip@example.com',
        password: TEST_PASSWORD,
        firstName: 'Audit',
        lastName: 'Probe',
      })
      .expect(201);

    const audit = await app
      .get(PrismaService)
      .auditLog.findFirstOrThrow({ where: { action: 'user.registered' } });
    return (
      (audit.metadata as { request?: { ip?: unknown; country?: unknown } })
        .request ?? {}
    );
  };

  describe('from a listed hop', () => {
    let app: INestApplication<App>;
    let restore: () => void;

    beforeAll(async () => {
      // Cloudflare-header trust ON, so the audit case below proves the
      // client IP still comes from the trusted hop and not from that header.
      ({ app, restore } = await withEnvironment(
        { TRUST_PROXY: '127.0.0.1', TRUST_CLOUDFLARE_HEADERS: 'true' },
        createTestApp,
      ));
    });

    afterAll(async () => {
      restore();
      await app?.close();
    });

    beforeEach(async () => {
      await truncateAll(app);
      await seedRbacCatalog(app);
    });

    it('records the forwarded client address and user agent on the session', async () => {
      const user = await createRegularUser(app, 'forwarded@example.com');

      await login(app, user.email, CLIENT_ADDRESS);

      const session = await loginSession(app, user.id);
      expect(session.ipAddress).toBe(CLIENT_ADDRESS);
      expect(session.userAgent).toBe(USER_AGENT);
    });

    // A client can prepend anything; only the entry the trusted hop appended
    // is believed. Express walks right to left and stops at the first
    // address that is not a listed hop.
    it('ignores addresses the client prepended to the forwarded chain', async () => {
      const user = await createRegularUser(app, 'prepended@example.com');

      await login(app, user.email, `${SPOOFED_ADDRESS}, ${CLIENT_ADDRESS}`);

      expect((await loginSession(app, user.id)).ipAddress).toBe(CLIENT_ADDRESS);
    });

    it('records the forwarded address in the audit trail, never CF-Connecting-IP', async () => {
      const envelope = await registerAndReadAuditEnvelope(app, {
        'X-Forwarded-For': CLIENT_ADDRESS,
        'CF-Connecting-IP': SPOOFED_ADDRESS,
        'CF-IPCountry': 'XX',
      });

      // Positive control: Cloudflare-header trust really is on in this block.
      expect(envelope.country).toBe('XX');
      expect(envelope.ip).toBe(CLIENT_ADDRESS);
    });
  });

  describe('from a peer that is not a listed hop', () => {
    let app: INestApplication<App>;
    let restore: () => void;

    beforeAll(async () => {
      ({ app, restore } = await withEnvironment(
        { TRUST_PROXY: '10.0.0.1', TRUST_CLOUDFLARE_HEADERS: 'true' },
        createTestApp,
      ));
    });

    afterAll(async () => {
      restore();
      await app?.close();
    });

    beforeEach(async () => {
      await truncateAll(app);
      await seedRbacCatalog(app);
    });

    // Positive control: the outcomes below match the `.env.test` default
    // (`false`) too, so prove this block really runs with a list that does
    // not include the peer.
    it('runs with a trusted-hop list that excludes the test client', () => {
      expect(
        (
          app.getHttpAdapter().getInstance() as { get(name: string): unknown }
        ).get('trust proxy'),
      ).toBe('10.0.0.1');
    });

    it('records the peer address, not the forwarded one', async () => {
      const user = await createRegularUser(app, 'untrusted@example.com');

      await login(app, user.email, SPOOFED_ADDRESS);

      const session = await loginSession(app, user.id);
      expect(LOOPBACK_ADDRESSES).toContain(session.ipAddress);
      expect(session.userAgent).toBe(USER_AGENT);
    });

    it('records the peer address in the audit trail whatever headers it sends', async () => {
      const envelope = await registerAndReadAuditEnvelope(app, {
        'X-Forwarded-For': SPOOFED_ADDRESS,
        'CF-Connecting-IP': SPOOFED_ADDRESS,
      });

      expect(LOOPBACK_ADDRESSES).toContain(envelope.ip);
    });
  });
});
