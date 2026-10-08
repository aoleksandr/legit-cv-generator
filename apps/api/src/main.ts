import './config.js'; // loads .env before anything reads process.env
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/http-exception.filter.js';
import { config } from './config.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.useBodyParser('json', { limit: '200kb' });
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  // Behind the web container's nginx in docker; needed for correct client IPs in rate limiting.
  app.set('trust proxy', 1);

  await app.listen(config.port);
  const log = new Logger('Bootstrap');
  log.log(`API listening on http://localhost:${config.port}/api`);
  if (!config.anthropicApiKey) log.warn('ANTHROPIC_API_KEY is not set: CV generation will fail until it is.');
}

void bootstrap();
