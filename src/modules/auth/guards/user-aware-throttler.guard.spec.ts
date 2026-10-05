import type { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { UserAwareThrottlerGuard } from './user-aware-throttler.guard';

// The tracker key IS the rate-limit boundary: whatever this returns is the
// bucket a request is counted against. Two failures matter most, and neither is
// visible from the outside —
//
//   • trusting an unverified token would let anyone mint a random `sub` per
//     request and get a fresh bucket each time, removing rate limiting
//     application-wide;
//   • throwing on a bad token would turn the throttler into an auth gate and
//     return the wrong status for expired sessions.
//
// Both are pinned below, along with the template's three additions: public
// routes stay on the IP, verification-link tokens get no user bucket, and the
// IP half keeps the library's IPv6 /64 grouping.
describe('UserAwareThrottlerGuard', () => {
  const SECRET = 'test-secret';
  const SERVICE_NAME = 'nestjs-api';

  const jwtService = new JwtService({});
  const configService = {
    getOrThrow: (key: string) => (key === 'jwt.secret' ? SECRET : SERVICE_NAME),
  } as unknown as ConfigService;

  // `ipv6SubnetPrefix` is set in onModuleInit from the module options; the
  // spec constructs the guard directly, so it initialises it the same way.
  const guard = new UserAwareThrottlerGuard(
    { throttlers: [] },
    {} as never,
    new Reflector(),
    jwtService,
    configService,
  );

  beforeAll(async () => {
    await guard.onModuleInit();
  });

  // Two route handlers, one carrying the metadata `@Public()` sets.
  class ProbeController {}
  const handlers = {
    authenticated: () => undefined,
    anonymous: () => undefined,
  };
  Reflect.defineMetadata(IS_PUBLIC_KEY, true, handlers.anonymous);

  const contextFor = (handler: keyof typeof handlers): ExecutionContext =>
    ({
      getHandler: () => handlers[handler],
      getClass: () => ProbeController,
    }) as unknown as ExecutionContext;

  // getTracker is protected; the bucket key is exactly what we want to assert.
  // `context` defaults to a non-public route; pass `null` to omit it.
  const trackerFor = (
    request: Partial<Request>,
    context: ExecutionContext | null = contextFor('authenticated'),
  ): Promise<string> =>
    (
      guard as unknown as {
        getTracker: (
          request: Request,
          context?: ExecutionContext,
        ) => Promise<string>;
      }
    ).getTracker(request as Request, context ?? undefined);

  const sign = (payload: object, options: object = {}) =>
    jwtService.sign(payload, {
      secret: SECRET,
      issuer: SERVICE_NAME,
      audience: SERVICE_NAME,
      expiresIn: '5m',
      ...options,
    });

  const signValidToken = (subject: string) => sign({ sub: subject });

  const requestWith = (
    authorization?: string,
    ip = '203.0.113.7',
  ): Partial<Request> =>
    ({
      ip,
      headers: authorization ? { authorization } : {},
    }) as Partial<Request>;

  it('keys an authenticated caller on their user id', async () => {
    const token = signValidToken('user-123');

    await expect(trackerFor(requestWith(`Bearer ${token}`))).resolves.toBe(
      'user:user-123',
    );
  });

  it('gives two users behind one IP separate buckets', async () => {
    const firstTracker = await trackerFor(
      requestWith(`Bearer ${signValidToken('user-a')}`),
    );
    const secondTracker = await trackerFor(
      requestWith(`Bearer ${signValidToken('user-b')}`),
    );

    // The whole point: same shared IP, different quotas.
    expect(firstTracker).not.toBe(secondTracker);
  });

  it('keys an anonymous caller on their IP', async () => {
    await expect(trackerFor(requestWith())).resolves.toBe('ip:203.0.113.7');
  });

  it('keys impersonated traffic on the actor, not the impersonated user', async () => {
    const token = sign({ sub: 'impersonated-user', act: 'administrator' });

    await expect(trackerFor(requestWith(`Bearer ${token}`))).resolves.toBe(
      'user:administrator',
    );
  });

  // A token on a public route buys no quota: one address holding N accounts
  // would otherwise multiply every public per-route limit by N.
  it('keys a public route on the IP even with a valid token', async () => {
    const token = signValidToken('user-123');

    await expect(
      trackerFor(requestWith(`Bearer ${token}`), contextFor('anonymous')),
    ).resolves.toBe('ip:203.0.113.7');
  });

  it('keys on the IP when no execution context is available', async () => {
    const token = signValidToken('user-123');

    await expect(
      trackerFor(requestWith(`Bearer ${token}`), null),
    ).resolves.toBe('ip:203.0.113.7');
  });

  // THE security case. A token signed with the wrong secret must NOT be
  // trusted — otherwise a forged `sub` per request means unlimited buckets.
  it('ignores a token signed with the wrong secret', async () => {
    const forged = sign(
      { sub: 'attacker-chosen' },
      { secret: 'not-the-real-secret' },
    );

    await expect(trackerFor(requestWith(`Bearer ${forged}`))).resolves.toBe(
      'ip:203.0.113.7',
    );
  });

  it.each([
    ['a wrong issuer', { issuer: 'someone-else' }],
    ['a wrong audience', { audience: 'someone-else' }],
    ['a non-HS256 algorithm', { algorithm: 'HS384' }],
  ])('ignores a token with %s', async (_case, options) => {
    const token = sign({ sub: 'user-123' }, options);

    await expect(trackerFor(requestWith(`Bearer ${token}`))).resolves.toBe(
      'ip:203.0.113.7',
    );
  });

  // Same secret, issuer and audience — but signed for an email-verification
  // link, which JwtStrategy refuses as an access token.
  it('ignores a token signed for another purpose', async () => {
    const token = sign({ sub: 'user-123', purpose: 'email_verify' });

    await expect(trackerFor(requestWith(`Bearer ${token}`))).resolves.toBe(
      'ip:203.0.113.7',
    );
  });

  it('falls back to the IP for an expired token rather than throwing', async () => {
    const expired = sign({ sub: 'user-123' }, { expiresIn: '-1s' });

    // Must NOT throw — throttling is not an auth decision. JwtAuthGuard raises
    // the real 401 downstream; an expired session still gets rate limited.
    await expect(trackerFor(requestWith(`Bearer ${expired}`))).resolves.toBe(
      'ip:203.0.113.7',
    );
  });

  it.each([
    ['a malformed token', 'Bearer not-a-jwt'],
    ['a non-bearer scheme', 'Basic dXNlcjpwYXNz'],
    ['an empty bearer value', 'Bearer '],
  ])('falls back to the IP for %s', async (_case, authorization) => {
    await expect(trackerFor(requestWith(authorization))).resolves.toBe(
      'ip:203.0.113.7',
    );
  });

  it('accepts a lower-case bearer scheme, as passport-jwt does', async () => {
    const token = signValidToken('user-123');

    await expect(trackerFor(requestWith(`bearer ${token}`))).resolves.toBe(
      'user:user-123',
    );
  });

  it('never returns a bare IP that could collide with a user id', async () => {
    const anonymousTracker = await trackerFor(requestWith());
    const authenticatedTracker = await trackerFor(
      // A user whose id is literally the IP string — contrived, but proves the
      // namespaces cannot alias.
      requestWith(`Bearer ${signValidToken('203.0.113.7')}`),
    );

    expect(anonymousTracker).not.toBe(authenticatedTracker);
  });

  // A raw `request.ip` would give an IPv6 client a fresh bucket for every
  // address in its /64 — the library's own grouping must survive the override.
  it('groups IPv6 callers by their /64, like the stock tracker', async () => {
    const first = await trackerFor(requestWith(undefined, '2001:db8:0:1::1'));
    const second = await trackerFor(
      requestWith(undefined, '2001:db8:0:1:ffff::2'),
    );
    const otherPrefix = await trackerFor(
      requestWith(undefined, '2001:db8:0:2::1'),
    );

    expect(first).toBe(second);
    expect(first).not.toBe(otherPrefix);
  });

  it('treats an IPv4-mapped address as its IPv4 address', async () => {
    await expect(
      trackerFor(requestWith(undefined, '::ffff:203.0.113.7')),
    ).resolves.toBe('ip:203.0.113.7');
  });
});
