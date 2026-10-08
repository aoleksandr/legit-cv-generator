import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CV_LLM, MastraCvLlm } from './ai/cv-llm.js';
import { AuthModule } from './auth/auth.module.js';
import { CvsController } from './cvs/cvs.controller.js';
import { CvsService } from './cvs/cvs.service.js';
import { GenerationService } from './generation/generation.service.js';
import { HealthController } from './health.controller.js';
import { IngestionService } from './ingestion/ingestion.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { QuestionsService } from './questions/questions.service.js';
import { QueueService } from './queue/queue.service.js';

@Module({
  imports: [
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
  ],
})
export class AppModule {}
