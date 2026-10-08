import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { JobWithMetadata } from 'pg-boss';
import { applyAnswer, splicePart } from '../ai/apply-answer.js';
import { CV_LLM, LlmError, type CvLlm } from '../ai/cv-llm.js';
import { runGeneration } from '../ai/generation.workflow.js';
import { config } from '../config.js';
import { readContent, readFacts } from '../cvs/cv.mapper.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QUEUES, QueueService } from '../queue/queue.service.js';

interface GenerateJob {
  cvId: string;
}
interface ApplyAnswerJob {
  questionId: string;
}

const SWEEP_INTERVAL_MS = 60_000;
/** A CV still "queued" after this long has lost its job (e.g. enqueue raced a crash). */
const STALE_QUEUED_MS = 2 * 60_000;
/** Longer than the job expiry; by then pg-boss has retried or failed the job. */
const STALE_PROCESSING_MS = 20 * 60_000;

/**
 * Background worker. All progress and results are written to the database,
 * so the browser can reload or switch devices at any point and just poll.
 */
@Injectable()
export class GenerationService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(GenerationService.name);
  private sweeper?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    @Inject(CV_LLM) private readonly llm: CvLlm,
  ) {}

  async onApplicationBootstrap() {
    if (!config.workerEnabled) return;
    await this.queue.work<GenerateJob>(QUEUES.generate, (job) => this.handleGenerate(job));
    await this.queue.work<ApplyAnswerJob>(QUEUES.applyAnswer, (job) => this.handleApplyAnswer(job));
    await this.sweep();
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
  }

  onModuleDestroy() {
    clearInterval(this.sweeper);
  }

  // -------------------------------------------------------------------------
  // CV generation
  // -------------------------------------------------------------------------

  async handleGenerate(job: Pick<JobWithMetadata<GenerateJob>, 'data' | 'retryCount' | 'retryLimit'>) {
    const { cvId } = job.data;
    const cv = await this.prisma.cv.findUnique({ where: { id: cvId } });
    if (!cv || cv.status === 'ready') return;

    await this.prisma.cv.update({
      where: { id: cvId },
      data: { status: 'processing', progressStep: null, error: null },
    });

    try {
      const result = await runGeneration(
        this.llm,
        { sourceText: cv.sourceText, targetRole: cv.targetRole },
        async (step) => {
          await this.prisma.cv.update({ where: { id: cvId }, data: { progressStep: step } });
        },
      );
      if (result.removed.length) {
        this.logger.log(
          `CV ${cvId}: grounding removed ${result.removed.length} item(s):\n  ${result.removed.join('\n  ')}`,
        );
      }

      await this.prisma.$transaction([
        this.prisma.cvQuestion.deleteMany({ where: { cvId } }),
        this.prisma.cvQuestion.createMany({
          data: result.questions.map((q) => ({ cvId, fieldPath: q.fieldPath, question: q.question })),
        }),
        this.prisma.cv.update({
          where: { id: cvId },
          data: {
            content: result.content,
            facts: result.facts,
            status: 'ready',
            progressStep: null,
            error: null,
            version: { increment: 1 },
          },
        }),
      ]);
    } catch (err) {
      await this.onJobError(err, job, async (message, final) => {
        await this.prisma.cv.update({
          where: { id: cvId },
          data: final ? { status: 'failed', error: message, progressStep: null } : { error: `${message} Retrying…` },
        });
      });
    }
  }

  // -------------------------------------------------------------------------
  // Applying an answer to one part of the CV
  // -------------------------------------------------------------------------

  async handleApplyAnswer(job: Pick<JobWithMetadata<ApplyAnswerJob>, 'data' | 'retryCount' | 'retryLimit'>) {
    const { questionId } = job.data;
    const question = await this.prisma.cvQuestion.findUnique({ where: { id: questionId }, include: { cv: true } });
    if (!question || !question.applying || question.answer == null) return;
    const cv = question.cv;
    const content = readContent(cv);
    if (!content) {
      await this.prisma.cvQuestion.update({
        where: { id: questionId },
        data: { applying: false, error: 'The CV has no content to update.' },
      });
      return;
    }

    try {
      const result = await applyAnswer(this.llm, {
        content,
        facts: readFacts(cv),
        questionId,
        fieldPath: question.fieldPath,
        question: question.question,
        answer: question.answer,
        targetRole: cv.targetRole,
      });
      if (result.removed.length) {
        this.logger.log(`Answer ${questionId}: grounding removed:\n  ${result.removed.join('\n  ')}`);
      }

      await this.prisma.$transaction(async (tx) => {
        // Lock the row: manual edits that landed while the model was working must not be lost.
        await tx.$queryRaw`SELECT id FROM cvs WHERE id = ${cv.id}::uuid FOR UPDATE`;
        const latest = await tx.cv.findUniqueOrThrow({ where: { id: cv.id } });
        const latestContent = readContent(latest) ?? content;
        const merged =
          latest.version === cv.version
            ? result.content
            : splicePart(latestContent, result.content, question.fieldPath);
        await tx.cv.update({
          where: { id: cv.id },
          data: { content: merged, facts: result.facts, version: { increment: 1 } },
        });
        await tx.cvQuestion.update({
          where: { id: questionId },
          data: { status: 'answered', applying: false, error: null },
        });
      });
    } catch (err) {
      await this.onJobError(err, job, async (message, final) => {
        await this.prisma.cvQuestion.update({
          where: { id: questionId },
          data: final ? { applying: false, error: message } : { error: `${message} Retrying…` },
        });
      });
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Non-retryable errors (bad input, auth) fail immediately with a readable
   * message. Retryable ones are rethrown so pg-boss retries with backoff; the
   * last attempt records the failure for the user.
   */
  private async onJobError(
    err: unknown,
    job: { retryCount: number; retryLimit: number },
    record: (message: string, final: boolean) => Promise<void>,
  ) {
    const llmError = err instanceof LlmError ? err : null;
    const retryable = llmError ? llmError.retryable : true;
    const final = !retryable || job.retryCount >= job.retryLimit;
    const message = llmError?.message ?? 'Something went wrong while processing your CV.';

    this.logger.error(
      `Job failed (attempt ${job.retryCount + 1}/${job.retryLimit + 1}, final=${final}): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    await record(message, final);
    if (!final) throw err;
  }

  /** Re-enqueue CVs whose job went missing. `exclusive` queues make this a no-op when the job still exists. */
  private async sweep() {
    try {
      const now = Date.now();
      const stale = await this.prisma.cv.findMany({
        where: {
          OR: [
            { status: 'queued', updatedAt: { lt: new Date(now - STALE_QUEUED_MS) } },
            { status: 'processing', updatedAt: { lt: new Date(now - STALE_PROCESSING_MS) } },
          ],
        },
        select: { id: true },
        take: 100,
      });
      for (const { id } of stale) {
        await this.queue.send(QUEUES.generate, { cvId: id }, id);
        await this.prisma.cv.update({ where: { id }, data: { updatedAt: new Date() } });
      }
      const staleAnswers = await this.prisma.cvQuestion.findMany({
        where: { applying: true, createdAt: { lt: new Date(now - STALE_QUEUED_MS) } },
        select: { id: true },
        take: 100,
      });
      for (const { id } of staleAnswers) await this.queue.send(QUEUES.applyAnswer, { questionId: id }, id);
      if (stale.length) this.logger.warn(`Re-enqueued ${stale.length} stale CV job(s)`);
    } catch (err) {
      this.logger.error(`Sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
