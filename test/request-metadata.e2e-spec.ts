import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { truncateAll } from './setup/db';
import { seedRbacCatalog } from './setup/rbac';
import { createTestApp } from './setup/test-app';

interface RequestEnvelope {
  requestId?: string;
  ip?: string;
  country?: string;
  cfRay?: string;
  method?: string;
  path?: string;
}

/**
 * The correlation contract.
 *
 * `X-Request-Id` is what ties a user-reported failure to a log line to an audit
 * row. It is only worth anything if all three carry the SAME value, and the
 * value is only safe if it cannot be chosen freely by the caller — the audit
 * envelope is the one place the platform claims to know what really happened.
 */
describe('Request metadata (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll(app);
    await seedRbacCatalog(app);
  });

  afterAll(async () => {
    await app.close();
  });

  // Registration audits unconditionally, so it is the cheapest way to get an
  // audit row with a request envelope attached.
  const registerWith = (headers: Record<string, string>, email: string) => {
    const pending = request(app.getHttpServer())
      .post('/api/auth/register')
      .send({
        email,
        password: 'correct-horse-battery-1',
        firstName: 'Meta',
        lastName: 'Probe',
      });
    for (const [name, value] of Object.entries(headers)) {
      void pending.set(name, value);
    }
    return pending;
  };

  const auditEnvelope = async (): Promise<RequestEnvelope> => {
    const prisma = app.get(PrismaService);
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'user.registered' },
      orderBy: { createdAt: 'desc' },
    });
    return (row.metadata as { request?: RequestEnvelope }).request ?? {};
  };

  describe('correlation', () => {
    it('the response header and the audit row carry the SAME id when NONE is supplied', async () => {
      // The case that was broken and that no previous test could catch: pino's
      // `genReqId` and the CLS `idGenerator` each minted their OWN UUID, so the
      // header the client sees and the id recorded in `audit_logs` disagreed on
      // every request that did not carry the header — i.e. essentially all real
      // traffic. A test that always SENDS the header agrees by luck.
      const response = await registerWith({}, 'nohead@example.com').expect(201);

      const headerId = response.headers['x-request-id'];
      expect(headerId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect((await auditEnvelope()).requestId).toBe(headerId);
    });

    it('honours a well-formed client-supplied id end to end', async () => {
      const response = await registerWith(
        { 'X-Request-Id': 'client-trace-123' },
        'supplied@example.com',
      ).expect(201);

      expect(response.headers['x-request-id']).toBe('client-trace-123');
      expect((await auditEnvelope()).requestId).toBe('client-trace-123');
    });
  });

  describe('a client-supplied id is untrusted input', () => {
    it('replaces an oversized id rather than persisting it', async () => {
      // Uncapped, this is ~16 KiB of attacker-chosen data per request into the
      // audit_logs JSONB column, from an unauthenticated endpoint.
      const oversized = 'a'.repeat(5_000);
      const response = await registerWith(
        { 'X-Request-Id': oversized },
        'oversized@example.com',
      ).expect(201);

      expect(response.headers['x-request-id']).not.toBe(oversized);
      const envelope = await auditEnvelope();
      expect(envelope.requestId).not.toBe(oversized);
      expect(envelope.requestId?.length).toBeLessThanOrEqual(200);
    });

    it('replaces an id carrying characters outside the safe set', async () => {
      // CR/LF is not tested here: Node's own HTTP client refuses to serialise a
      // header containing it, so that vector never reaches this code. The unit
      // spec covers it directly. What CAN arrive over the wire is anything
      // else printable — quotes and spaces break out of a quoted logfmt field,
      // and the value lands in a JSONB column read by admins.
      const injected = 'forged" level=error msg="owned';
      const response = await registerWith(
        { 'X-Request-Id': injected },
        'injected@example.com',
      ).expect(201);

      const headerId = response.headers['x-request-id'];
      expect(headerId).not.toBe(injected);
      expect(headerId).toMatch(/^[A-Za-z0-9._~-]+$/);
      // …and the replacement is what gets persisted, so the log and the audit
      // row still agree.
      expect((await auditEnvelope()).requestId).toBe(headerId);
    });
  });

  describe('Cloudflare headers', () => {
    // `.env.test` leaves TRUST_CLOUDFLARE_HEADERS unset, so the suite runs with
    // the safe default. That is deliberate: the default is what a fork inherits.
    it('are IGNORED when trust is disabled', async () => {
      await registerWith(
        {
          'CF-Connecting-IP': '203.0.113.9',
          'CF-IPCountry': 'XX',
          'CF-Ray': 'forged-ray-id',
        },
        'cf@example.com',
      ).expect(201);

      const envelope = await auditEnvelope();
      // The forged IP must not become the recorded one — audit_logs is the
      // table an incident responder trusts.
      expect(envelope.ip).not.toBe('203.0.113.9');
      expect(typeof envelope.ip).toBe('string');
      // A missing field is honest; a forged one is not.
      expect(envelope.country).toBeUndefined();
      expect(envelope.cfRay).toBeUndefined();
    });
  });

  it('records the server-vouched method and path, not anything the caller sent', async () => {
    await registerWith({}, 'envelope@example.com').expect(201);

    expect(await auditEnvelope()).toMatchObject({
      method: 'POST',
      path: '/api/auth/register',
    });
  });
});
