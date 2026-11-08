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
import { Throttle, ThrottlerModule } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { Public } from '../src/common/decorators/public.decorator';
import {
  THROTTLE_IPV6_SUBNET_PREFIX,
  loginThrottleTracker,
  passwordSignInThrottleKey,
} from '../src/common/util/login-throttle.util';
import { UserAwareThrottlerGuard } from '../src/modules/auth/guards/user-aware-throttler.guard';

// Password sign-in is limited per identifier + address, with an IPv6 address
// folded to its /64. The real app skips throttling under test (`skipIf` in
// AppModule), so this stands up a minimal app with throttling ON — the real
// guard, the real tracker on a route-level @Throttle exactly as the sign-in
// routes declare it, and the module's IPv6 prefix — driven over HTTP.

const SERVICE_NAME = 'sign-in-throttle';
const JWT_SECRET = 'sign-in-throttle-secret';
const PER_IDENTIFIER_LIMIT = 5;

@Controller('probe')
class SignInProbeController {
  @Post('sign-in')
  @Public()
  @Throttle({
    default: {
      limit: PER_IDENTIFIER_LIMIT,
      ttl: 60_000,
      getTracker: loginThrottleTracker,
      generateKey: passwordSignInThrottleKey,
    },
  })
  @HttpCode(200)
  signIn(): { ok: true } {
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
      throttlers: [{ ttl: 60_000, limit: 1_000 }],
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
  const signIn = (identifier: string, address = '203.0.113.7') =>
    request(app.getHttpServer())
      .post('/probe/sign-in')
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
});
