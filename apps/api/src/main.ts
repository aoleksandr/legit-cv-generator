import './config.js'; // loads .env before anything reads process.env
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { config } from './config.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  configureApp(app);
  app.enableShutdownHooks();

  await app.listen(config.port);
  const log = new Logger('Bootstrap');
  log.log(`API listening on http://localhost:${config.port}/api`);
  if (!config.anthropicApiKey) log.warn('ANTHROPIC_API_KEY is not set: CV generation will fail until it is.');
}

void bootstrap();
