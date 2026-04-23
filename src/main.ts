import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  const configService = app.get(ConfigService);
  const port = configService.getOrThrow<number>('port');
  const corsOrigin = configService.get<string>('cors.origin') ?? '*';
  const trustProxy = configService.getOrThrow<boolean | number | string>(
    'trustProxy',
  );

  app.set('trust proxy', trustProxy);
  app.use(helmet());
  app.setGlobalPrefix('api');
  app.enableCors({
    origin:
      corsOrigin === '*' ? true : corsOrigin.split(',').map((o) => o.trim()),
    credentials: true,
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle(configService.getOrThrow<string>('serviceName'))
    .setDescription('NestJS API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  app.enableShutdownHooks();

  await app.listen(port);
  app
    .get(Logger)
    .log(`API listening on http://localhost:${port}/api`, 'Bootstrap');
}

void bootstrap();
