import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './setup/test-app';
import { truncateAll } from './setup/db';

const VALID_PASSWORD = 'correct-horse-battery-1';

// Mark a registered user as email-verified directly in the DB so
// downstream tests can log in. Keeps test setup close to production
// behavior (same row shape) without needing to intercept / parse the
// stub-logged verification JWT.
async function markVerified(
  app: INestApplication<App>,
  email: string,
): Promise<void> {
  const prisma = app.get(PrismaService);
  await prisma.user.update({
    where: { email: email.toLowerCase() },
    data: { emailVerifiedAt: new Date() },
  });
}

// Fetches the user id after register — register returns only { message }
// now, so the id isn't in the response. Used by the verify-email JWT
// tests that need to sign a token with the user's sub.
async function getUserIdByEmail(
  app: INestApplication<App>,
  email: string,
): Promise<string> {
  const prisma = app.get(PrismaService);
  const row = await prisma.user.findUniqueOrThrow({
    where: { email: email.toLowerCase() },
  });
  return row.id;
}

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll(app);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/auth/register', () => {
    it('returns only a message (no user, no token) and creates an unverified row', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          email: 'alice@example.com',
          password: VALID_PASSWORD,
          firstName: 'Alice',
          lastName: 'Smith',
        })
        .expect(201);

      expect(res.body).toEqual({ message: expect.stringContaining('verify') });
      expect(res.body).not.toHaveProperty('user');
      expect(res.body).not.toHaveProperty('accessToken');

      // Row exists, unverified, with createdBy/updatedBy null.
      const prisma = app.get(PrismaService);
      const row = await prisma.user.findUniqueOrThrow({
        where: { email: 'alice@example.com' },
      });
      expect(row.role).toBe('user');
      expect(row.isActive).toBe(true);
      expect(row.emailVerifiedAt).toBeNull();
      expect(row.createdBy).toBeNull();
      expect(row.updatedBy).toBeNull();
    });

    it('lowercases the email on storage', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          email: 'MIXED@Example.COM',
          password: VALID_PASSWORD,
          firstName: 'Mix',
          lastName: 'Case',
        })
        .expect(201);
      const prisma = app.get(PrismaService);
      const row = await prisma.user.findUniqueOrThrow({
        where: { email: 'mixed@example.com' },
      });
      expect(row.email).toBe('mixed@example.com');
    });

    it('rejects duplicate email with 409 and field-aware message', async () => {
      const payload = {
        email: 'dup@example.com',
        password: VALID_PASSWORD,
        firstName: 'Dup',
        lastName: 'User',
      };
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .send(payload)
        .expect(201);
      const res = await request(app.getHttpServer())
        .post('/api/auth/register')
        .send(payload)
        .expect(409);
      expect(res.body.message).toMatch(/email already in use/i);
      // Error envelope contract (Phase B): every error carries a stable
      // machine-readable errorCode plus the standard envelope fields.
      expect(res.body.errorCode).toBe('UNIQUE_CONSTRAINT_VIOLATION');
      expect(res.body).toMatchObject({
        statusCode: 409,
        error: 'Conflict',
        details: { field: 'email' },
        path: '/api/auth/register',
      });
      expect(typeof res.body.timestamp).toBe('string');
    });

    it('rejects invalid email with 400', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          email: 'not-an-email',
          password: VALID_PASSWORD,
          firstName: 'X',
          lastName: 'Y',
        })
        .expect(400);
    });

    it('rejects too-short password with 400', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          email: 'short@example.com',
          password: 'short',
          firstName: 'X',
          lastName: 'Y',
        })
        .expect(400);
    });

    it('rejects extraneous fields with 400 (whitelist)', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          email: 'extra@example.com',
          password: VALID_PASSWORD,
          firstName: 'X',
          lastName: 'Y',
          phoneNumber: '+15551234',
          role: 'admin',
        })
        .expect(400);
    });
  });

  describe('POST /api/auth/login', () => {
    beforeEach(async () => {
      await request(app.getHttpServer()).post('/api/auth/register').send({
        email: 'bob@example.com',
        password: VALID_PASSWORD,
        firstName: 'Bob',
        lastName: 'Jones',
      });
    });

    it('blocks login when email is not verified (specific error)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'bob@example.com', password: VALID_PASSWORD })
        .expect(401);
      expect(res.body.errorCode).toBe('EMAIL_NOT_VERIFIED');
      expect(res.body.message).toMatch(/verify/i);
    });

    it('returns access token for valid credentials after verification', async () => {
      await markVerified(app, 'bob@example.com');
      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'bob@example.com', password: VALID_PASSWORD })
        .expect(200);
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.user.email).toBe('bob@example.com');
    });

    it('login is case-insensitive on email', async () => {
      await markVerified(app, 'bob@example.com');
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'BOB@example.com', password: VALID_PASSWORD })
        .expect(200);
    });

    it('rejects wrong password with generic 401 (no verification hint)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'bob@example.com', password: 'wrong-password-1' })
        .expect(401);
      // Unknown-email and wrong-password must be indistinguishable —
      // no EMAIL_NOT_VERIFIED leak for attackers who don't have the password.
      expect(res.body.errorCode).not.toBe('EMAIL_NOT_VERIFIED');
      expect(res.body.errorCode).toBe('INVALID_CREDENTIALS');
    });

    it('rejects unknown email with 401', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'nope@example.com', password: VALID_PASSWORD })
        .expect(401);
    });

    it('locks the account after 5 failed attempts (M6)', async () => {
      await markVerified(app, 'bob@example.com');
      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer())
          .post('/api/auth/login')
          .send({ email: 'bob@example.com', password: 'wrong-password-1' })
          .expect(401);
      }
      // Correct password is now rejected until lockout expires.
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'bob@example.com', password: VALID_PASSWORD })
        .expect(401);
    });
  });

  // Disposable / temporary email providers (mailinator, 10minutemail, …) are
  // blocked at the auth boundary — silently on register (no enumeration of
  // which domains are blocked) and as a generic INVALID_CREDENTIALS on login.
  // Both paths leave an internal audit_logs entry for ops.
  describe('disposable-email blocking (register + login)', () => {
    const DISPOSABLE = 'throwaway@mailinator.com';

    it('silently drops a disposable-email registration — byte-identical 201/body to a real one, no user row', async () => {
      const realRes = await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          email: 'real-cmp@example.com',
          password: VALID_PASSWORD,
          firstName: 'Real',
          lastName: 'User',
        })
        .expect(201);

      const blockedRes = await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          email: DISPOSABLE,
          password: VALID_PASSWORD,
          firstName: 'Throw',
          lastName: 'Away',
        })
        .expect(201);

      // Wire-shape parity — an attacker can't distinguish blocked from real.
      expect(blockedRes.body).toEqual(realRes.body);
      expect(blockedRes.body).toEqual({
        message: expect.stringContaining('verify'),
      });
      expect(blockedRes.body.errorCode).toBeUndefined();

      // No row written for the disposable email; the real one exists.
      const prisma = app.get(PrismaService);
      expect(await prisma.user.count({ where: { email: DISPOSABLE } })).toBe(0);
      expect(
        await prisma.user.count({ where: { email: 'real-cmp@example.com' } }),
      ).toBe(1);

      // Audit log captured the silent rejection (with the domain).
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'user.register_blocked_disposable_email' },
      });
      const meta = audit.metadata as { domain?: string };
      expect(meta.domain).toBe('mailinator.com');
    });

    it('blocks a disposable-email login as generic INVALID_CREDENTIALS (no disposable leak)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: DISPOSABLE, password: VALID_PASSWORD })
        .expect(401);
      // Collapsed into the same code as unknown-email / wrong-password so the
      // disposable check isn't distinguishable.
      expect(res.body.errorCode).toBe('INVALID_CREDENTIALS');

      const prisma = app.get(PrismaService);
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'user.login_blocked_disposable_email' },
      });
      expect(audit).not.toBeNull();
    });
  });

  // Every audit_logs entry written inside an HTTP request gets a server-vouched
  // `metadata.request` envelope, populated by the ClsModule middleware
  // (app.module.ts) and merged in AuditService. The disposable-register path
  // records an audit log within request context, so it exercises the envelope
  // without needing an authenticated session.
  describe('audit request-context envelope (ClsModule)', () => {
    it('auto-attaches metadata.request (requestId/method/path/userAgent/ip) to audit rows', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .set('User-Agent', 'AuditEnvelopeProbe/1.0')
        .set('X-Request-Id', 'test-req-id-123')
        .send({
          email: 'throwaway-env@mailinator.com',
          password: VALID_PASSWORD,
          firstName: 'A',
          lastName: 'B',
        })
        .expect(201);

      const prisma = app.get(PrismaService);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'user.register_blocked_disposable_email' },
      });
      const meta = audit.metadata as {
        request?: Record<string, unknown>;
      };
      expect(meta.request).toBeDefined();
      // requestId mirrors the supplied X-Request-Id (same value pino logs use).
      expect(meta.request).toMatchObject({
        requestId: 'test-req-id-123',
        method: 'POST',
        path: '/api/auth/register',
        userAgent: 'AuditEnvelopeProbe/1.0',
      });
      // ip is resolved server-side (req.ip / CF header) — present, a string.
      expect(typeof meta.request?.ip).toBe('string');
    });
  });

  describe('POST /api/auth/verify-email', () => {
    async function registerAndSignEmailVerifyToken(
      email: string,
      purpose: string = 'email_verify',
    ): Promise<string> {
      await request(app.getHttpServer()).post('/api/auth/register').send({
        email,
        password: VALID_PASSWORD,
        firstName: 'Verify',
        lastName: 'Flow',
      });
      const userId = await getUserIdByEmail(app, email);
      return app
        .get(JwtService)
        .sign({ sub: userId, purpose }, { expiresIn: '10m' });
    }

    it('verifies a user via a valid token and unblocks login', async () => {
      const token = await registerAndSignEmailVerifyToken(
        'verify-flow@example.com',
      );
      await request(app.getHttpServer())
        .post('/api/auth/verify-email')
        .send({ token })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'verify-flow@example.com', password: VALID_PASSWORD })
        .expect(200);
    });

    it('also accepts GET /api/auth/verify-email?token=... for direct email clicks', async () => {
      const token = await registerAndSignEmailVerifyToken(
        'verify-get@example.com',
      );
      // GET form is for direct email-link clicks — 302-redirects to the
      // public web app's verify landing page with `?status=success`.
      // (POST form returns JSON for SPAs that handle the token in-app.)
      const res = await request(app.getHttpServer())
        .get(`/api/auth/verify-email?token=${encodeURIComponent(token)}`)
        .expect(302);
      expect(res.headers.location).toContain('status=success');
    });

    it('rejects a token with the wrong purpose claim (400)', async () => {
      const token = await registerAndSignEmailVerifyToken(
        'purpose@example.com',
        'password_reset',
      );
      await request(app.getHttpServer())
        .post('/api/auth/verify-email')
        .send({ token })
        .expect(400);
    });

    it('rejects a garbage token with 400', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/verify-email')
        .send({ token: 'eyJ0.definitely.not-a-real-jwt' })
        .expect(400);
    });

    it('is idempotent — re-verifying an already-verified user returns 200', async () => {
      const token = await registerAndSignEmailVerifyToken('idem@example.com');
      await request(app.getHttpServer())
        .post('/api/auth/verify-email')
        .send({ token })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/auth/verify-email')
        .send({ token })
        .expect(200);
    });

    it('email-verify tokens cannot be used as access tokens', async () => {
      const token = await registerAndSignEmailVerifyToken(
        'no-auth@example.com',
      );
      // JwtStrategy rejects tokens with a `purpose` claim.
      await request(app.getHttpServer())
        .get('/api/users/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });
  });

  describe('POST /api/auth/resend-verification', () => {
    it('always returns 200 — even for unregistered emails (no enumeration)', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/resend-verification')
        .send({ email: 'ghost@example.com' })
        .expect(200);

      await request(app.getHttpServer()).post('/api/auth/register').send({
        email: 'real@example.com',
        password: VALID_PASSWORD,
        firstName: 'R',
        lastName: 'E',
      });
      await request(app.getHttpServer())
        .post('/api/auth/resend-verification')
        .send({ email: 'real@example.com' })
        .expect(200);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('revokes the exact token it was called with; other tokens stay valid', async () => {
      await request(app.getHttpServer()).post('/api/auth/register').send({
        email: 'logout@example.com',
        password: VALID_PASSWORD,
        firstName: 'Log',
        lastName: 'Out',
      });
      await markVerified(app, 'logout@example.com');

      const first = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'logout@example.com', password: VALID_PASSWORD });
      const second = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'logout@example.com', password: VALID_PASSWORD });

      const tokenA = first.body.accessToken;
      const tokenB = second.body.accessToken;

      await request(app.getHttpServer())
        .get('/api/users/me')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/users/me')
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(204);

      await request(app.getHttpServer())
        .get('/api/users/me')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(401);
      await request(app.getHttpServer())
        .get('/api/users/me')
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);
    });

    it('requires authentication', async () => {
      await request(app.getHttpServer()).post('/api/auth/logout').expect(401);
    });
  });

  describe('POST /api/auth/logout-all', () => {
    it('revokes every active token for the user', async () => {
      await request(app.getHttpServer()).post('/api/auth/register').send({
        email: 'logout-all@example.com',
        password: VALID_PASSWORD,
        firstName: 'Log',
        lastName: 'Out',
      });
      await markVerified(app, 'logout-all@example.com');

      const loginA = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'logout-all@example.com', password: VALID_PASSWORD });
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const loginB = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'logout-all@example.com', password: VALID_PASSWORD });

      const tokenA = loginA.body.accessToken;
      const tokenB = loginB.body.accessToken;

      await new Promise((resolve) => setTimeout(resolve, 1100));
      await request(app.getHttpServer())
        .post('/api/auth/logout-all')
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(204);

      await request(app.getHttpServer())
        .get('/api/users/me')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(401);
      await request(app.getHttpServer())
        .get('/api/users/me')
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(401);

      await new Promise((resolve) => setTimeout(resolve, 1100));
      const loginC = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'logout-all@example.com', password: VALID_PASSWORD })
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/users/me')
        .set('Authorization', `Bearer ${loginC.body.accessToken}`)
        .expect(200);
    });
  });

  describe('GET /api/users/me', () => {
    let token: string;

    beforeEach(async () => {
      await request(app.getHttpServer()).post('/api/auth/register').send({
        email: 'carol@example.com',
        password: VALID_PASSWORD,
        firstName: 'Carol',
        lastName: 'Lee',
      });
      await markVerified(app, 'carol@example.com');
      const login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'carol@example.com', password: VALID_PASSWORD });
      token = login.body.accessToken as string;
    });

    it('returns current user profile with valid token', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/users/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body).toMatchObject({
        email: 'carol@example.com',
        firstName: 'Carol',
        role: 'user',
        isActive: true,
      });
      expect(res.body).not.toHaveProperty('password');
    });

    it('rejects request without a token with 401', async () => {
      await request(app.getHttpServer()).get('/api/users/me').expect(401);
    });

    it('rejects malformed token with 401', async () => {
      await request(app.getHttpServer())
        .get('/api/users/me')
        .set('Authorization', 'Bearer junk')
        .expect(401);
    });
  });
});
