import {
  ClassSerializerInterceptor,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import type { Request } from 'express';
import Redis from 'ioredis';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import { UAParser } from 'ua-parser-js';
import { AuditModule } from './common/audit/audit.module';
import { Errors } from './common/errors/errors';
import { flattenValidationErrors } from './common/errors/flatten-validation-errors';
import { buildPinoHttpOptions } from './common/logging/pino-http-options';
import { redactUrlSecrets } from './common/util/redact-url-secrets.util';
// Still used by the CLS middleware's idGenerator below; the logger's own copy
// moved into buildPinoHttpOptions, and both call this same memoised resolver so
// the two cannot disagree about a request's id.
import { resolveRequestId } from './common/util/request-id.util';
import { EmailModule } from './common/email/email.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { QueueModule } from './common/queue/queue.module';
import { buildRedisConnectionOptions } from './common/redis/redis-connection';
import { RedisModule } from './common/redis/redis.module';
import { TelemetryShutdownService } from './common/telemetry/telemetry-shutdown.service';
import { SmsModule } from './common/sms/sms.module';
import { FileStorageModule } from './common/storage/file-storage.module';
import configuration from './config/configuration';
import { envValidationSchema } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { PermissionsGuard } from './modules/authorization/guards/permissions.guard';
import { AppVersionsModule } from './modules/app-versions/app-versions.module';
import { AuditLogsModule } from './modules/audit-logs/audit-logs.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { AuthorizationModule } from './modules/authorization/authorization.module';
import { BusinessesModule } from './modules/businesses/businesses.module';
import { DeviceTokensModule } from './modules/device-tokens/device-tokens.module';
import { EnumsModule } from './modules/enums/enums.module';
import { HealthModule } from './modules/health/health.module';
import { QueueAdminModule } from './modules/queue-admin/queue-admin.module';
import { RolesModule } from './modules/roles/roles.module';
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
    // DI graph and tank perf).
    //
    // `idGenerator` and the LoggerModule's `genReqId` below both call the SAME
    // `resolveRequestId`, which memoises per request — so the `X-Request-Id`
    // response header, pino's `req.id`, the error envelope's `requestId`, and
    // `audit_logs.metadata.request.requestId` are one value by construction.
    // (Two independent copies of "header else randomUUID()" agreed only when
    // the client supplied the header, and diverged on all other traffic.)
    //
    // `setup` captures everything AuditService merges into `metadata.request`
    // on every `record()` call. Two tiers of forensic value:
    //   - Tier 1 (zero-ops): `request.ip`, `User-Agent` (+ parsed
    //     browser/os/device via `ua-parser-js`), `Accept-Language`, `method`,
    //     `path`. Pure local parsing; works in dev and behind any proxy.
    //   - Tier 2 (behind Cloudflare, and ONLY when TRUST_CLOUDFLARE_HEADERS is
    //     enabled): `CF-Connecting-IP` overrides `request.ip`; `CF-IPCountry`
    //     gives a 2-letter ISO country; `CF-Ray` is the cross-system trace id.
    // Every field is optional and AuditService skips empties, so a sparse
    // envelope (local dev, non-browser UAs) is never noisy.
    ClsModule.forRootAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        // Resolved once at boot, not per request.
        //
        // These headers are trivially forgeable by anyone who can reach the
        // origin directly, and they land in `audit_logs` — the table whose
        // whole purpose is to be trustworthy after an incident. Defaulting to
        // OFF means a fork that deploys without the `cloudflare_only` Caddy
        // snippet records the IP Express actually saw, rather than one the
        // caller chose for it.
        const trustCloudflareHeaders = configService.getOrThrow<boolean>(
          'cloudflare.trustHeaders',
        );
        return {
          middleware: {
            mount: true,
            generateId: true,
            idGenerator: (request: Request) => resolveRequestId(request),
            setup: (cls, request: Request) => {
              // Tier 1: User-Agent + parsed browser/OS/device.
              const uaHeader = request.headers['user-agent'];
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

              const acceptLanguage = request.headers['accept-language'];
              if (
                typeof acceptLanguage === 'string' &&
                acceptLanguage.length > 0
              ) {
                cls.set('acceptLanguage', acceptLanguage);
              }

              // Tier 2: Cloudflare-injected headers, read ONLY when the operator
              // has asserted that the origin is unreachable except through
              // Cloudflare. With the flag off, `ip` is whatever Express resolved
              // from `trust proxy`, and `country` / `cfRay` are simply absent —
              // a missing field is honest, a forged one is not.
              if (trustCloudflareHeaders) {
                const cfConnectingIp = request.headers['cf-connecting-ip'];
                cls.set(
                  'ip',
                  typeof cfConnectingIp === 'string' &&
                    cfConnectingIp.length > 0
                    ? cfConnectingIp
                    : request.ip,
                );

                const cfCountry = request.headers['cf-ipcountry'];
                if (typeof cfCountry === 'string' && cfCountry.length > 0) {
                  cls.set('country', cfCountry);
                }

                const cfRay = request.headers['cf-ray'];
                if (typeof cfRay === 'string' && cfRay.length > 0) {
                  cls.set('cfRay', cfRay);
                }
              } else {
                cls.set('ip', request.ip);
              }

              cls.set('method', request.method);
              // Redacted like every other URL sink. This one is the
              // DURABLE sink: AuditService merges it into
              // `audit_logs.metadata.request.path`, so an unredacted value
              // persists a query-string credential in the database — the table
              // an incident responder reads, and every backup of it.
              cls.set(
                'path',
                redactUrlSecrets(request.originalUrl || request.url),
              );
            },
          },
        };
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
      useFactory: (configService: ConfigService) => ({
        // Options live in `common/logging/pino-http-options.ts` so they can be
        // driven through a real pino-http instance by a spec. They used to be
        // inline here, and the redact paths were addressed to `request.*` /
        // `response.*` while pino-http logs under `req` / `res` — so every path
        // matched nothing and Authorization and Cookie headers were written to
        // stdout in clear, while the config, a comment and the docs all claimed
        // otherwise. Inline options nobody can execute is how that survived.
        pinoHttp: buildPinoHttpOptions({
          isProduction: configService.get<string>('nodeEnv') === 'production',
          isTest: configService.get<string>('nodeEnv') === 'test',
        }),
      }),
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
                // Same builder as RedisService and BullMQ — see
                // src/common/redis/redis-connection.ts. This client used to be
                // constructed from the bare URL, which would have silently
                // skipped TLS on a managed Redis the other two reached over an
                // encrypted connection.
                new Redis({
                  ...buildRedisConnectionOptions(configService),
                  // Lazy, matching RedisService. The worker runtime builds the
                  // same AppModule and therefore this same client, but never
                  // serves an HTTP request and so never reads a rate-limit
                  // counter — without this, every worker instance holds a
                  // connection open to a store it will not use.
                  lazyConnect: true,
                }),
              ),
        };
      },
    }),
    // There is no in-process scheduler. BullMQ is the SINGLE mechanism for all
    // background work — immediate, delayed, recurring, retried — and its
    // recurring half (job schedulers, declared in
    // `common/queue/recurring-schedule-registry.ts`) lives in Redis rather than
    // in a process. That is what lets the HTTP API scale horizontally without N
    // instances each firing the same sweep, and what makes a recurring job
    // survive the restart of the instance that installed it.
    PrismaModule,
    RedisModule,
    QueueModule,
    EmailModule,
    SmsModule,
    AuditModule,
    FileStorageModule,
    AuthorizationModule,
    AuthModule,
    UsersModule,
    RolesModule,
    BusinessesModule,
    AuditLogsModule,
    AppVersionsModule,
    DeviceTokensModule,
    EnumsModule,
    HealthModule,
    QueueAdminModule,
    PublicModule,
  ],
  providers: [
    // Participates in enableShutdownHooks() so pending spans and metrics are
    // flushed after the modules close, instead of being dropped on exit.
    TelemetryShutdownService,
    // Guard order is the execution order. Throttle before authenticating (an
    // unauthenticated flood must not reach the database), authenticate before
    // authorizing (PermissionsGuard needs `request.user`).
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Authentication is now GLOBAL. Every handler requires a valid JWT unless
    // it carries `@Public()`. Controllers no longer apply JwtAuthGuard
    // themselves.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Authorization is global and fails closed: a handler with no @Public() /
    // @AuthenticatedOnly() / @RequirePermission() is denied. The boot-time
    // RouteAuthorizationAuditService stops the app from starting at all in
    // that case, so this is defence in depth.
    { provide: APP_GUARD, useClass: PermissionsGuard },
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
