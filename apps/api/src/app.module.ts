import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { CV_LLM, MastraCvLlm } from './ai/cv-llm.js';
import { AuthModule } from './auth/auth.module.js';
import { logContext } from './common/log-context.js';
import { config } from './config.js';
import { CvsController } from './cvs/cvs.controller.js';
import { CvsService } from './cvs/cvs.service.js';
import { GenerationService } from './generation/generation.service.js';
import { HealthController } from './health.controller.js';
import { IngestionService } from './ingestion/ingestion.service.js';
import { PdfService } from './pdf/pdf.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { QuestionsService } from './questions/questions.service.js';
import { QueueService } from './queue/queue.service.js';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: config.logLevel,
        // Job context (cvId, questionId, attempt) on every line written inside a job.
        mixin: logContext,
        redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
        customLogLevel: (_req, res, err) =>
          err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
        // Polled every 2 s by the UI and probed by Docker: logging those would drown everything else.
        autoLogging: {
          ignore: (req) =>
            req.url === '/api/health' || (req.method === 'GET' && /^\/api\/cvs\/[^/]+$/.test(req.url ?? '')),
        },
        transport: config.prettyLogs ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
      },
    }),
    PrismaModule,
    AuthModule,
    // Generous default; expensive/sensitive routes set tighter limits with @Throttle.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
  ],
  controllers: [HealthController, CvsController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: CV_LLM, useClass: MastraCvLlm },
    QueueService,
    CvsService,
    QuestionsService,
    IngestionService,
    GenerationService,
    PdfService,
  ],
})
export class AppModule {}
