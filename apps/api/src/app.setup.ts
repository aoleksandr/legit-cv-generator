import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AllExceptionsFilter } from './common/http-exception.filter.js';

/** HTTP setup shared by main.ts and the e2e tests, so tests exercise the real configuration. */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  app.useBodyParser('json', { limit: '200kb' });
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());
  // Behind the web container's nginx in docker; needed for correct client IPs in rate limiting.
  app.set('trust proxy', 1);
  return app;
}
