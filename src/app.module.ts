import {
  ClassSerializerInterceptor,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { randomUUID } from 'crypto';
import type { Request } from 'express';
import Redis from 'ioredis';
import type { IncomingMessage, ServerResponse } from 'http';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import { UAParser } from 'ua-parser-js';
import { AuditModule } from './common/audit/audit.module';
import { Errors } from './common/errors/errors';
import { flattenValidationErrors } from './common/errors/flatten-validation-errors';
import { EmailModule } from './common/email/email.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { RedisModule } from './common/redis/redis.module';
import { ScheduledJobsModule } from './common/scheduled-jobs/scheduled-jobs.module';
import { SmsModule } from './common/sms/sms.module';
import { FileStorageModule } from './common/storage/file-storage.module';
import configuration from './config/configuration';
import { envValidationSchema } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { AppVersionsModule } from './modules/app-versions/app-versions.module';
import { AuthModule } from './modules/auth/auth.module';
import { DeviceTokensModule } from './modules/device-tokens/device-tokens.module';
import { EnumsModule } from './modules/enums/enums.module';
import { HealthModule } from './modules/health/health.module';
import { PublicModule } from './modules/public/public.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      expandVariables: true,
      load: [configuration],
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: true },
    }),
    // Continuation-local storage: opens an async-local context for every
    // HTTP request so downstream services (AuditService, …) can read request
    // metadata without threading it through every callsite or switching to
    // `Scope.REQUEST` (which would propagate request scope through the whole
    // DI graph and tank perf). `idGenerator` mirrors the LoggerModule's
    // `genReqId` logic below — the same UUID is reused if the client sent
    // `X-Request-Id`, otherwise we mint one — so pino logs and
    // audit_logs.metadata.request.requestId agree for a given request.
    //
    // `setup` captures everything AuditService merges into `metadata.request`
    // on every `record()` call. Two tiers of forensic value:
    //   - Tier 1 (zero-ops): `req.ip`, `User-Agent` (+ parsed
    //     browser/os/device via `ua-parser-js`), `Accept-Language`, `method`,
    //     `path`. Pure local parsing; works in dev and behind any proxy.
    //   - Tier 2 (free behind Cloudflare): `CF-Connecting-IP` overrides
    //     `req.ip`; `CF-IPCountry` gives a 2-letter ISO country; `CF-Ray` is
    //     the cross-system trace id. Trusted blindly because the origin is
    //     allowlisted to CF IPs at the infra layer — don't expose the origin
    //     directly or an attacker can spoof these.
    // Every field is optional and AuditService skips empties, so a sparse
    // envelope (local dev, non-browser UAs) is never noisy.
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req: Request) => {
          const headerId = req.headers['x-request-id'];
          return typeof headerId === 'string' && headerId.length > 0
            ? headerId
            : randomUUID();
        },
        setup: (cls, req: Request) => {
          // Tier 1: User-Agent + parsed browser/OS/device.
          const uaHeader = req.headers['user-agent'];
          const userAgent =
            typeof uaHeader === 'string' && uaHeader.length > 0
              ? uaHeader
              : undefined;
          if (userAgent) {
            cls.set('userAgent', userAgent);
            const parsed = UAParser(userAgent);
            if (parsed.browser.name) {
              cls.set('browser', {
                name: parsed.browser.name,
                version: parsed.browser.version,
              });
            }
            if (parsed.os.name) {
              cls.set('os', {
                name: parsed.os.name,
                version: parsed.os.version,
              });
            }
            // Skip the `device` key for desktop UAs (all three sub-fields are
            // undefined for Chrome on Mac, etc.). Only mobile / tablet /
            // console / smarttv / wearable / xr / embedded UAs populate any.
            const deviceType = parsed.device.type;
            const deviceVendor = parsed.device.vendor;
            const deviceModel = parsed.device.model;
            if (deviceType || deviceVendor || deviceModel) {
              cls.set('device', {
                type: deviceType,
                vendor: deviceVendor,
                model: deviceModel,
              });
            }
          }

          const acceptLanguage = req.headers['accept-language'];
          if (typeof acceptLanguage === 'string' && acceptLanguage.length > 0) {
            cls.set('acceptLanguage', acceptLanguage);
          }

          // Tier 2: Cloudflare-injected headers. `CF-Connecting-IP` is the
          // canonical client IP; falls back to `req.ip` (Express-resolved via
          // `trust proxy`) for non-CF traffic / local dev.
          const cfConnectingIp = req.headers['cf-connecting-ip'];
          cls.set(
            'ip',
            typeof cfConnectingIp === 'string' && cfConnectingIp.length > 0
              ? cfConnectingIp
              : req.ip,
          );

          const cfCountry = req.headers['cf-ipcountry'];
          if (typeof cfCountry === 'string' && cfCountry.length > 0) {
            cls.set('country', cfCountry);
          }

          const cfRay = req.headers['cf-ray'];
          if (typeof cfRay === 'string' && cfRay.length > 0) {
            cls.set('cfRay', cfRay);
          }

          cls.set('method', req.method);
          cls.set('path', req.originalUrl || req.url);
        },
      },
    }),
    // Structured JSON logs in prod/staging; pretty-printed in local dev.
    // Every request gets an X-Request-Id (reused if the client supplies one)
    // for trace correlation. Auth headers are redacted from logs.
    // (See providers below: APP_PIPE = ValidationPipe, APP_INTERCEPTOR =
    // ClassSerializerInterceptor, APP_FILTER = GlobalExceptionFilter,
    // APP_GUARD = ThrottlerGuard.)
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const isProd = configService.get<string>('nodeEnv') === 'production';
        const isTest = configService.get<string>('nodeEnv') === 'test';
        return {
          pinoHttp: {
            level: isTest ? 'silent' : isProd ? 'info' : 'debug',
            transport:
              !isProd && !isTest
                ? { target: 'pino-pretty', options: { singleLine: true } }
                : undefined,
            genReqId: (req: IncomingMessage, res: ServerResponse) => {
              const headerId = req.headers['x-request-id'];
              const id =
                typeof headerId === 'string' && headerId.length > 0
                  ? headerId
                  : randomUUID();
              res.setHeader('X-Request-Id', id);
              return id;
            },
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.body.password',
                'req.body.newPassword',
                'req.body.currentPassword',
                'req.body.otp',
              ],
              censor: '[redacted]',
            },
          },
        };
      },
    }),
    // Redis-backed throttler storage — each pod sees the same counter, so
    // a user hitting N pods in parallel still respects the per-IP limit.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const isTest = configService.get<string>('nodeEnv') === 'test';
        return {
          throttlers: [
            {
              ttl: configService.getOrThrow<number>('throttle.ttlMs'),
              limit: configService.getOrThrow<number>('throttle.limit'),
            },
          ],
          skipIf: () => isTest,
          // Test env keeps in-memory storage (the @nestjs/throttler default)
          // so e2e runs don't depend on a live Redis. Dev/staging/prod share
          // via Redis.
          storage: isTest
            ? undefined
            : new ThrottlerStorageRedisService(
                new Redis(configService.getOrThrow<string>('redis.url')),
              ),
        };
      },
    }),
    // Cron host. Schedulers register themselves via @Cron decorators in
    // services. forRoot() is enough — there's no per-environment gating
    // because each scheduled job is responsible for being a no-op in
    // test (e.g. checking NODE_ENV) or just being idempotent.
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    EmailModule,
    SmsModule,
    AuditModule,
    FileStorageModule,
    ScheduledJobsModule,
    AuthModule,
    UsersModule,
    AppVersionsModule,
    DeviceTokensModule,
    EnumsModule,
    HealthModule,
    PublicModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
        // Route class-validator failures through the standard error envelope
        // (400 VALIDATION_FAILED) with flattened, form-name-keyed details
        // (`{ field, constraints }[]`) instead of Nest's default ad-hoc
        // message array — so clients program against one consistent shape.
        exceptionFactory: (errors) =>
          Errors.validationFailed(flattenValidationErrors(errors)),
      }),
    },
    { provide: APP_INTERCEPTOR, useClass: ClassSerializerInterceptor },
    // Single global filter — catches Prisma errors, every HttpException
    // (tagged via Errors.* or framework-raised), and unknown throwables,
    // emitting the standard error envelope. Replaces the legacy
    // AllExceptionsFilter + PrismaExceptionFilter pair.
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule {}
