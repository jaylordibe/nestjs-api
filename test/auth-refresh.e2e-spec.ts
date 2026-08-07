import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { truncateAll } from './setup/db';
import { seedRbacCatalog } from './setup/rbac';
import { createTestApp } from './setup/test-app';

const PASSWORD = 'correct-horse-battery-1';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}
interface ErrorBody {
  errorCode: string;
}

/**
 * Refresh-token rotation and replay detection.
 *
 * The contract these specs pin down, in one sentence: a refresh token is
 * single-use, and using one twice is treated as theft rather than as a retry.
 * The second half is the part worth testing hardest — it is the only mechanism
 * that limits how long a stolen token stays useful, and it is invisible in
 * ordinary happy-path traffic, so nothing else would notice it regressing.
 */
describe('Auth refresh tokens (e2e)', () => {
  let app: INestApplication<App>;

  const registerVerifiedUser = async (email: string): Promise<void> => {
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({
        email,
        password: PASSWORD,
        firstName: 'Refresh',
        lastName: 'Tester',
      })
      .expect(201);
    const prisma = app.get(PrismaService);
    // `email` is unique only among live rows (partial index), so look the row
    // up before updating it by id.
    const user = await prisma.user.findFirstOrThrow({
      where: { email: email.toLowerCase() },
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date() },
    });
  };

  const login = async (email: string): Promise<TokenPair> => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ identifier: email, password: PASSWORD })
      .expect(200);
    return response.body as TokenPair;
  };

  const refresh = (refreshToken: string) =>
    request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken });

  const signedInUser = async (
    email = 'refresh@example.com',
  ): Promise<TokenPair> => {
    await registerVerifiedUser(email);
    return login(email);
  };

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

  // ── issue ────────────────────────────────────────────────────────────────

  it('login issues an access token AND a refresh token', async () => {
    const tokens = await signedInUser();

    expect(typeof tokens.accessToken).toBe('string');
    expect(typeof tokens.refreshToken).toBe('string');
    expect(tokens.refreshToken.length).toBeGreaterThan(20);
  });

  // The token is the credential; the database must hold only a digest of it,
  // so that reading the table does not hand over usable sessions.
  it('stores only a hash of the refresh token, never the token itself', async () => {
    const tokens = await signedInUser();

    const prisma = app.get(PrismaService);
    const stored = await prisma.refreshToken.findMany({
      select: { tokenHash: true },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0].tokenHash).not.toBe(tokens.refreshToken);
    // SHA-256, hex-encoded.
    expect(stored[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  // ── rotation ─────────────────────────────────────────────────────────────

  it('exchanges a refresh token for a NEW pair', async () => {
    const tokens = await signedInUser();

    const response = await refresh(tokens.refreshToken).expect(200);
    const renewed = response.body as TokenPair;

    expect(renewed.accessToken).toBeTruthy();
    expect(renewed.refreshToken).not.toBe(tokens.refreshToken);
  });

  it('issues an access token that actually authenticates', async () => {
    const tokens = await signedInUser();
    const response = await refresh(tokens.refreshToken).expect(200);

    await request(app.getHttpServer())
      .get('/api/users/me')
      .set(
        'Authorization',
        `Bearer ${(response.body as TokenPair).accessToken}`,
      )
      .expect(200);
  });

  it('retires the old refresh token on exchange', async () => {
    const tokens = await signedInUser();
    await refresh(tokens.refreshToken).expect(200);

    const replay = await refresh(tokens.refreshToken).expect(401);
    expect((replay.body as ErrorBody).errorCode).toBe('REFRESH_TOKEN_INVALID');
  });

  // ── replay detection ─────────────────────────────────────────────────────

  /**
   * The reason rotation exists.
   *
   * A correct client discards a refresh token the instant it exchanges it, so a
   * second presentation means the token was captured. The server cannot tell
   * which presenter is the thief, so it trusts neither and ends the whole
   * chain — including the token it handed out moments ago to the legitimate
   * client. Signing the real user out is the intended cost; the alternative is
   * an attacker holding an indefinitely renewable session.
   */
  it('revokes the ENTIRE session family when a consumed token is replayed', async () => {
    const tokens = await signedInUser();
    const renewed = (await refresh(tokens.refreshToken).expect(200))
      .body as TokenPair;

    // The attacker replays the token they captured.
    await refresh(tokens.refreshToken).expect(401);

    // …and the legitimate client's brand-new token is dead too.
    const legitimate = await refresh(renewed.refreshToken).expect(401);
    expect((legitimate.body as ErrorBody).errorCode).toBe(
      'REFRESH_TOKEN_INVALID',
    );
  });

  it('treats a CONCURRENT double-exchange as replay, not as a lost race', async () => {
    // The case a sequential test cannot reach. Both requests read the token
    // row before either has consumed it, so both see `consumedAt: null` and
    // both skip the ordinary replay branch — the conditional consume is the
    // only thing that separates them.
    //
    // Returning a bare 401 to the loser would silently defeat RFC 9700 §4.14.2
    // reuse detection roughly half the time: an attacker racing the legitimate
    // client keeps a live, renewable family, and the real user — told only
    // "your session has expired" — simply signs in again while nothing anywhere
    // records that one token was presented twice.
    const tokens = await signedInUser();

    const [first, second] = await Promise.all([
      refresh(tokens.refreshToken),
      refresh(tokens.refreshToken),
    ]);

    // Exactly one winner.
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 401]);

    // The winner's brand-new replacement must ALSO be dead: the family was
    // revoked on the evidence that the token was presented twice, and a
    // revocation that leaves one live child has not ended the session.
    const winner = (first.status === 200 ? first : second).body as TokenPair;
    const afterReplay = await refresh(winner.refreshToken).expect(401);
    expect((afterReplay.body as ErrorBody).errorCode).toBe(
      'REFRESH_TOKEN_INVALID',
    );

    // Assert the database directly rather than trusting the status codes — a
    // revocation that failed to commit could still produce the 401 above by
    // some other path.
    const prisma = app.get(PrismaService);
    const live = await prisma.refreshToken.count({
      where: { revokedAt: null },
    });
    expect(live).toBe(0);

    // …and the theft is visible to whoever investigates it later.
    const audited = await prisma.auditLog.findFirst({
      where: { action: 'auth.refresh_token.replay_detected' },
    });
    expect(audited).not.toBeNull();
  });

  it('records the replay in the audit trail', async () => {
    const tokens = await signedInUser();
    await refresh(tokens.refreshToken).expect(200);
    await refresh(tokens.refreshToken).expect(401);

    const prisma = app.get(PrismaService);
    const audited = await prisma.auditLog.findFirst({
      where: { action: 'auth.refresh_token.replay_detected' },
    });
    expect(audited).not.toBeNull();
  });

  // ── rejection paths ──────────────────────────────────────────────────────

  // One code for unknown / expired / consumed / revoked. Distinguishing them
  // would confirm to a caller that a token it holds is genuine.
  it('rejects an unknown refresh token', async () => {
    await signedInUser();
    const response = await refresh('a'.repeat(43)).expect(401);
    expect((response.body as ErrorBody).errorCode).toBe(
      'REFRESH_TOKEN_INVALID',
    );
  });

  it('rejects an expired refresh token', async () => {
    const tokens = await signedInUser();
    const prisma = app.get(PrismaService);
    await prisma.refreshToken.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await refresh(tokens.refreshToken).expect(401);
  });

  it('rejects a refresh token belonging to a deactivated account', async () => {
    const tokens = await signedInUser();
    const prisma = app.get(PrismaService);
    const user = await prisma.user.findFirstOrThrow({
      where: { email: 'refresh@example.com' },
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { isActive: false },
    });

    await refresh(tokens.refreshToken).expect(401);
  });

  // A deactivated account must not merely fail once — the whole chain closes,
  // so nothing is left that would spring back to life if the account were
  // reactivated later.
  it('revokes every session when a deactivated account attempts refresh', async () => {
    const tokens = await signedInUser();
    const prisma = app.get(PrismaService);
    const user = await prisma.user.findFirstOrThrow({
      where: { email: 'refresh@example.com' },
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { isActive: false },
    });
    await refresh(tokens.refreshToken).expect(401);

    const live = await prisma.refreshToken.count({
      where: { userId: user.id, revokedAt: null },
    });
    expect(live).toBe(0);
  });

  // ── logout ───────────────────────────────────────────────────────────────

  // Blocklisting the access token alone would be theatre: the client would
  // still hold a refresh token able to mint a replacement seconds later.
  it('logout revokes the refresh chain, not just the access token', async () => {
    const tokens = await signedInUser();

    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ refreshToken: tokens.refreshToken })
      .expect(204);

    await refresh(tokens.refreshToken).expect(401);
  });

  it('logout still succeeds when the client omits its refresh token', async () => {
    const tokens = await signedInUser();

    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({})
      .expect(204);
  });

  // `passwordChangedAt` only invalidates stateless ACCESS tokens via their
  // `iat`. Refresh tokens are rows and carry no `iat`, so logout-all has to
  // revoke them explicitly or "sign me out everywhere" would leave every
  // device able to mint new access tokens.
  it('logout-all revokes refresh tokens on every device', async () => {
    await registerVerifiedUser('multi@example.com');
    const firstDevice = await login('multi@example.com');
    const secondDevice = await login('multi@example.com');

    await request(app.getHttpServer())
      .post('/api/auth/logout-all')
      .set('Authorization', `Bearer ${firstDevice.accessToken}`)
      .expect(204);

    await refresh(firstDevice.refreshToken).expect(401);
    await refresh(secondDevice.refreshToken).expect(401);
  });

  // Two sign-ins are two independent chains. A replay on one must not sign the
  // user out of the other, or a single compromised device would take down every
  // session the user has.
  it('keeps separate logins in separate families', async () => {
    await registerVerifiedUser('multi@example.com');
    const firstDevice = await login('multi@example.com');
    const secondDevice = await login('multi@example.com');

    await refresh(firstDevice.refreshToken).expect(200);
    await refresh(firstDevice.refreshToken).expect(401);

    // The other device is untouched.
    await refresh(secondDevice.refreshToken).expect(200);
  });
});
