import {
  Controller,
  HttpCode,
  INestApplication,
  Module,
  Post,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { Public } from '../src/common/decorators/public.decorator';
import { ThrottleSignIn } from '../src/common/decorators/throttle-sign-in.decorator';
import {
  THROTTLE_IPV6_SUBNET_PREFIX,
  signInAddressThrottler,
} from '../src/common/util/login-throttle.util';
import { UserAwareThrottlerGuard } from '../src/modules/auth/guards/user-aware-throttler.guard';

// Password sign-in is limited per identifier + address and per address alone,
// with an IPv6 address folded to its /64. The real app skips throttling under
// test (`skipIf` in AppModule), so this stands up a minimal app with
// throttling ON — the real guard, the real `@ThrottleSignIn()`, the real
// address throttler and the module's IPv6 prefix — driven over HTTP.

const SERVICE_NAME = 'sign-in-throttle';
const JWT_SECRET = 'sign-in-throttle-secret';
const PER_IDENTIFIER_LIMIT = 5;
const PER_ADDRESS_LIMIT = 30;

@Controller('probe')
class SignInProbeController {
  @Post('sign-in')
  @Public()
  @ThrottleSignIn()
  @HttpCode(200)
  signIn(): { ok: true } {
    return { ok: true };
  }

  // A second sign-in form: shares both budgets with the first.
  @Post('other-sign-in')
  @Public()
  @ThrottleSignIn()
  @HttpCode(200)
  otherSignIn(): { ok: true } {
    return { ok: true };
  }

  // Any other public route: the address throttler never counts it.
  @Post('other')
  @Public()
  @HttpCode(200)
  other(): { ok: true } {
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
      throttlers: [
        { ttl: 60_000, limit: 1_000 },
        signInAddressThrottler(false),
      ],
      ipv6SubnetPrefix: THROTTLE_IPV6_SUBNET_PREFIX,
    }),
  ],
  controllers: [SignInProbeController],
  providers: [{ provide: APP_GUARD, useClass: UserAwareThrottlerGuard }],
})
class SignInThrottleProbeModule {}

describe('Password sign-in throttling (e2e)', () => {
  let app: INestApplication<App>;

  // supertest always connects from loopback; trusting loopback lets each
  // request name its client address in X-Forwarded-For.
  const signIn = (
    identifier: string,
    address = '203.0.113.7',
    path = '/probe/sign-in',
  ) =>
    request(app.getHttpServer())
      .post(path)
      .set('X-Forwarded-For', address)
      .send({ identifier, password: 'irrelevant1' });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SignInThrottleProbeModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    (app as unknown as NestExpressApplication).set('trust proxy', 'loopback');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('refuses repeated tries at one identifier past the per-identifier limit', async () => {
    for (let attempt = 0; attempt < PER_IDENTIFIER_LIMIT; attempt += 1) {
      await signIn('victim@example.com').expect(200);
    }

    const refused = await signIn('VICTIM@example.com').expect(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    // Another identifier from the same address still gets through.
    await signIn('someone-else@example.com').expect(200);
  });

  it('gives every address in one IPv6 /64 one shared allowance', async () => {
    for (let attempt = 0; attempt < PER_IDENTIFIER_LIMIT; attempt += 1) {
      // A new address inside the same /64 for every try.
      await signIn('victim@example.com', `2001:db8:1:2::${attempt + 1}`).expect(
        200,
      );
    }
    await signIn('victim@example.com', '2001:db8:1:2:ffff::99').expect(429);

    // A different /64 is a different address.
    await signIn('victim@example.com', '2001:db8:1:3::1').expect(200);
  });

  it('refuses one address past the per-address limit across identifiers and forms', async () => {
    for (let attempt = 0; attempt < PER_ADDRESS_LIMIT; attempt += 1) {
      // A fresh identifier every time, alternating the two sign-in forms.
      const path =
        attempt % 2 === 0 ? '/probe/sign-in' : '/probe/other-sign-in';
      await signIn(`user${attempt}@example.com`, '198.51.100.4', path).expect(
        200,
      );
    }

    const refused = await signIn('one-more@example.com', '198.51.100.4').expect(
      429,
    );
    // The standard header, not only the library's `Retry-After-<name>`.
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);

    // Another address is unaffected.
    await signIn('one-more@example.com', '198.51.100.5').expect(200);
  });

  it('leaves every other route uncounted by the address throttler', async () => {
    const other = await request(app.getHttpServer())
      .post('/probe/other')
      .set('X-Forwarded-For', '198.51.100.6')
      .send({})
      .expect(200);
    expect(other.headers['x-ratelimit-limit-sign-in-address']).toBeUndefined();

    const signedIn = await signIn('a@example.com', '198.51.100.6').expect(200);
    expect(signedIn.headers['x-ratelimit-limit-sign-in-address']).toBe(
      String(PER_ADDRESS_LIMIT),
    );
    expect(signedIn.headers['x-ratelimit-remaining-sign-in-address']).toBe(
      String(PER_ADDRESS_LIMIT - 1),
    );
  });
});
