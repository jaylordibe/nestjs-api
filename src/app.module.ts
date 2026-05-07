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
import Redis from 'ioredis';
import type { IncomingMessage, ServerResponse } from 'http';
import { LoggerModule } from 'nestjs-pino';
import { AuditModule } from './common/audit/audit.module';
import { EmailModule } from './common/email/email.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';
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
    // Structured JSON logs in prod/staging; pretty-printed in local dev.
    // Every request gets an X-Request-Id (reused if the client supplies one)
    // for trace correlation. Auth headers are redacted from logs.
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
      }),
    },
    { provide: APP_INTERCEPTOR, useClass: ClassSerializerInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_FILTER, useClass: PrismaExceptionFilter },
  ],
})
export class AppModule {}
