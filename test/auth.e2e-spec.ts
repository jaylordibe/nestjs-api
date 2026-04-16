import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './setup/test-app';
import { truncateAll } from './setup/db';

const VALID_PASSWORD = 'correct-horse-battery';

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
          role: 'USER',
          isActive: true,
        },
      });
      expect(res.body.user).not.toHaveProperty('password');
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
          role: 'ADMIN',
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
        role: 'USER',
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
