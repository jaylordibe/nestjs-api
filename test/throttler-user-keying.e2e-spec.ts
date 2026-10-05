import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { Public } from '../src/common/decorators/public.decorator';
import { UserAwareThrottlerGuard } from '../src/modules/auth/guards/user-aware-throttler.guard';

// Proves the guard is actually WIRED IN, not just that its logic is right.
//
// The unit spec calls `getTracker` directly, and the real app disables
// throttling under test (`skipIf` in AppModule), so between them nothing
// exercises the one thing that makes this feature work: @nestjs/throttler
// binding the subclass override into the request path during `onModuleInit`.
// Without this spec, a throttler release that moves that binding or changes the
// tracker precedence chain would leave every unit test and the build green
// while production silently reverted to pure-IP keying — everyone behind one
// shared address on one quota again, with no signal until they hit 429s.
//
// So this stands up a MINIMAL app — two routes, a two-request limit, throttling
// genuinely on — and drives it over HTTP. It deliberately does not touch the
// real AppModule or the database: the question is whether the override reaches
// the request pipeline, and a small rig answers that far more legibly. The real
// AppModule's wiring is covered by external-exposure.e2e-spec.ts.

const JWT_SECRET = 'throttler-keying-secret';
const SERVICE_NAME = 'throttler-keying';
const REQUEST_LIMIT = 2;

@Controller('probe')
class ProbeController {
  @Get()
  ping(): { ok: true } {
    return { ok: true };
  }

  @Public()
  @Get('public')
  publicPing(): { ok: true } {
    return { ok: true };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      load: [
        () => ({ serviceName: SERVICE_NAME, jwt: { secret: JWT_SECRET } }),
      ],
    }),
    JwtModule.register({ secret: JWT_SECRET }),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: REQUEST_LIMIT }],
    }),
  ],
  controllers: [ProbeController],
  providers: [{ provide: APP_GUARD, useClass: UserAwareThrottlerGuard }],
})
class ThrottlerProbeModule {}

describe('Throttler user keying (e2e)', () => {
  let app: INestApplication<App>;
  let jwtService: JwtService;

  const tokenFor = (userId: string) =>
    jwtService.sign(
      { sub: userId },
      {
        secret: JWT_SECRET,
        issuer: SERVICE_NAME,
        audience: SERVICE_NAME,
        expiresIn: '5m',
      },
    );

  const probe = (token?: string, path = '/probe') => {
    const pending = request(app.getHttpServer()).get(path);
    return token ? pending.set('Authorization', `Bearer ${token}`) : pending;
  };

  const exhaustBudget = async (token?: string, path = '/probe') => {
    for (let attempt = 0; attempt < REQUEST_LIMIT; attempt += 1) {
      await probe(token, path).expect(200);
    }
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerProbeModule],
    }).compile();
    app = moduleRef.createNestApplication();
    // init() runs onModuleInit, which is where the throttler binds the tracker
    // override — the exact step this spec exists to verify.
    await app.init();
    jwtService = app.get(JwtService);
  });

  afterEach(async () => {
    await app.close();
  });

  it('throttles an anonymous caller once its budget is spent', async () => {
    await exhaustBudget();

    await probe().expect(429);
  });

  // THE point of the whole change: same IP (supertest always connects from
  // loopback), different users, independent budgets.
  it('gives two authenticated users their own budget from one IP', async () => {
    await exhaustBudget(tokenFor('user-a'));
    await probe(tokenFor('user-a')).expect(429);

    // user-b is untouched despite sharing user-a's IP. Under the stock
    // IP-keyed guard this request would be a 429.
    await probe(tokenFor('user-b')).expect(200);
  });

  it('keeps an authenticated budget separate from the shared guest budget', async () => {
    await exhaustBudget();
    await probe().expect(429);

    // Guests are exhausted; a signed-in user on the same IP is unaffected.
    await probe(tokenFor('user-c')).expect(200);
  });

  it('falls back to the guest budget for an unverifiable token', async () => {
    const forged = jwtService.sign(
      { sub: 'attacker-chosen' },
      {
        secret: 'wrong-secret',
        issuer: SERVICE_NAME,
        audience: SERVICE_NAME,
        expiresIn: '5m',
      },
    );

    // Exhaust the GUEST budget, then confirm the forged token lands in it
    // rather than minting a private one — otherwise anyone could rotate `sub`
    // for unlimited quota.
    await exhaustBudget();

    await probe(forged).expect(429);
  });

  // A public route is anonymous by design: a valid token there must not buy a
  // private budget, or N accounts on one address multiply its limit by N.
  it('keeps a public route on the IP budget even with a valid token', async () => {
    await exhaustBudget(undefined, '/probe/public');

    await probe(tokenFor('user-e'), '/probe/public').expect(429);
  });

  it('treats a lower-case bearer scheme the same as the canonical one', async () => {
    const token = tokenFor('user-d');
    await exhaustBudget();

    // passport-jwt accepts `bearer`, so the throttler must too, or an
    // authenticated client silently loses its private budget.
    await request(app.getHttpServer())
      .get('/probe')
      .set('Authorization', `bearer ${token}`)
      .expect(200);
  });
});
