import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './setup/test-app';
import { truncateAll } from './setup/db';

const VALID_PASSWORD = 'correct-horse-battery-1';

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
    it('creates a user and returns an access token', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          email: 'alice@example.com',
          password: VALID_PASSWORD,
          firstName: 'Alice',
          lastName: 'Smith',
        })
        .expect(201);

      expect(res.body).toMatchObject({
        accessToken: expect.any(String),
        user: {
          email: 'alice@example.com',
          firstName: 'Alice',
          lastName: 'Smith',
          role: 'user',
          isActive: true,
        },
      });
      expect(res.body.user).not.toHaveProperty('password');
    });

    it('leaves createdBy and updatedBy null (unauthenticated create)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          email: 'noactor@example.com',
          password: VALID_PASSWORD,
          firstName: 'No',
          lastName: 'Actor',
        })
        .expect(201);
      expect(res.body.user.createdBy).toBeNull();
      expect(res.body.user.updatedBy).toBeNull();
    });

    it('lowercases the email on storage', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          email: 'MIXED@Example.COM',
          password: VALID_PASSWORD,
          firstName: 'Mix',
          lastName: 'Case',
        })
        .expect(201);
      expect(res.body.user.email).toBe('mixed@example.com');
    });

    it('rejects duplicate email with 409', async () => {
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
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .send(payload)
        .expect(409);
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
          role: 'admin',
          isActive: false,
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

    it('returns access token for valid credentials', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'bob@example.com', password: VALID_PASSWORD })
        .expect(200);
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.user.email).toBe('bob@example.com');
    });

    it('login is case-insensitive on email', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'BOB@example.com', password: VALID_PASSWORD })
        .expect(200);
    });

    it('rejects wrong password with 401', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'bob@example.com', password: 'wrong-password-1' })
        .expect(401);
    });

    it('rejects unknown email with 401', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'nope@example.com', password: VALID_PASSWORD })
        .expect(401);
    });

    it('locks the account after 5 failed attempts (M6)', async () => {
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

  describe('POST /api/auth/logout', () => {
    it('revokes the exact token it was called with; other tokens stay valid', async () => {
      await request(app.getHttpServer()).post('/api/auth/register').send({
        email: 'logout@example.com',
        password: VALID_PASSWORD,
        firstName: 'Log',
        lastName: 'Out',
      });

      // Two independent logins → two different tokens with different jti.
      const first = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'logout@example.com', password: VALID_PASSWORD });
      const second = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'logout@example.com', password: VALID_PASSWORD });

      const tokenA = first.body.accessToken;
      const tokenB = second.body.accessToken;

      // Both tokens work before logout.
      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);

      // Logout token A.
      await request(app.getHttpServer())
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(204);

      // Token A is revoked; token B is unaffected.
      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(401);
      await request(app.getHttpServer())
        .get('/api/auth/me')
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
      const loginA = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'logout-all@example.com', password: VALID_PASSWORD });
      // Wait past a full second so token B is issued in a strictly later
      // second than the passwordChangedAt bump from the eventual logout-all
      // call won't accidentally catch token B too (we want ALL tokens
      // issued BEFORE logout-all to be revoked).
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const loginB = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'logout-all@example.com', password: VALID_PASSWORD });

      const tokenA = loginA.body.accessToken;
      const tokenB = loginB.body.accessToken;

      // Wait past another second so logout-all's passwordChangedAt is in
      // a strictly later second than token B's iat.
      await new Promise((resolve) => setTimeout(resolve, 1100));

      await request(app.getHttpServer())
        .post('/api/auth/logout-all')
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(204);

      // Both pre-existing tokens are revoked.
      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(401);
      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(401);

      // Fresh login after logout-all works.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const loginC = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'logout-all@example.com', password: VALID_PASSWORD })
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${loginC.body.accessToken}`)
        .expect(200);
    });
  });

  describe('GET /api/auth/me', () => {
    let token: string;

    beforeEach(async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          email: 'carol@example.com',
          password: VALID_PASSWORD,
          firstName: 'Carol',
          lastName: 'Lee',
        });
      token = res.body.accessToken as string;
    });

    it('returns current user profile with valid token', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/auth/me')
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
      await request(app.getHttpServer()).get('/api/auth/me').expect(401);
    });

    it('rejects malformed token with 401', async () => {
      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', 'Bearer junk')
        .expect(401);
    });
  });
});
