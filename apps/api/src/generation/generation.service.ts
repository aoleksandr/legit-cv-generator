import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { JobWithMetadata } from 'pg-boss';
import { applyAnswer, splicePart } from '../ai/apply-answer.js';
import { CV_LLM, LlmError, type CvLlm } from '../ai/cv-llm.js';
import { runGeneration } from '../ai/generation.workflow.js';
import { withLogContext } from '../common/log-context.js';
import { config } from '../config.js';
import { readContent, readFacts } from '../cvs/cv.mapper.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { JOB_EXPIRE_SECONDS, QUEUES, QueueService, type QueueName } from '../queue/queue.service.js';

interface GenerateJob {
  cvId: string;
}
interface ApplyAnswerJob {
  questionId: string;
}

/**
 * The parts of a pg-boss job the handlers use. pg-boss aborts `signal` when the
 * job expires (and then retries it) or when the worker shuts down.
 */
type JobAttempt<T> = Pick<JobWithMetadata<T>, 'data' | 'retryCount' | 'retryLimit'> & { signal?: AbortSignal };

const TOOK_TOO_LONG = 'This took too long. Please try again.';

/** How a job attempt ended, for the `job_finished` log line. A thrown attempt is logged as `will_retry`. */
type JobOutcome = 'done' | 'failed' | 'skipped' | 'superseded';

const SWEEP_INTERVAL_MS = 60_000;
/** A CV still "queued" after this long has lost its job (e.g. enqueue raced a crash). */
const STALE_QUEUED_MS = 2 * 60_000;
/** Longer than the job expiry; by then pg-boss has retried or failed the job. */
const STALE_PROCESSING_MS = (JOB_EXPIRE_SECONDS + 5 * 60) * 1000;

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

  handleGenerate(job: JobAttempt<GenerateJob>): Promise<void> {
    return this.runJob(QUEUES.generate, { cvId: job.data.cvId }, job, () => this.generate(job));
  }

  private async generate(job: JobAttempt<GenerateJob>): Promise<JobOutcome> {
    const { cvId } = job.data;
    const cv = await this.prisma.cv.findUnique({ where: { id: cvId } });
    if (!cv || cv.status === 'ready') return 'skipped';

    await this.prisma.cv.update({
      where: { id: cvId },
      data: { status: 'processing', progressStep: null, error: null },
    });

    const record = async (message: string, final: boolean) => {
      await this.prisma.cv.update({
        where: { id: cvId },
        data: final ? { status: 'failed', error: message, progressStep: null } : { error: `${message} Retrying…` },
      });
    };

    try {
      const result = await runGeneration(
        this.llm,
        { sourceText: cv.sourceText, targetRole: cv.targetRole },
        async (step) => {
          if (job.signal?.aborted) return;
          await this.prisma.cv.update({ where: { id: cvId }, data: { progressStep: step } });
        },
        job.signal,
      );
      if (this.supersededBy(job)) return 'superseded';
      this.logRemoved(result.removed);

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
      return this.onJobError(err, job, record);
    }
    return 'done';
  }

  // -------------------------------------------------------------------------
  // Applying an answer to one part of the CV
  // -------------------------------------------------------------------------

  handleApplyAnswer(job: JobAttempt<ApplyAnswerJob>): Promise<void> {
    return this.runJob(QUEUES.applyAnswer, { questionId: job.data.questionId }, job, () => this.applyAnswer(job));
  }

  private async applyAnswer(job: JobAttempt<ApplyAnswerJob>): Promise<JobOutcome> {
    const { questionId } = job.data;
    const question = await this.prisma.cvQuestion.findUnique({ where: { id: questionId }, include: { cv: true } });
    if (!question || !question.applying || question.answer == null) return 'skipped';
    const cv = question.cv;
    const content = readContent(cv);
    if (!content) {
      await this.prisma.cvQuestion.update({
        where: { id: questionId },
        data: { applying: false, error: 'The CV has no content to update.' },
      });
      return 'failed';
    }

    const record = async (message: string, final: boolean) => {
      await this.prisma.cvQuestion.update({
        where: { id: questionId },
        data: final ? { applying: false, error: message } : { error: `${message} Retrying…` },
      });
    };

    try {
      const result = await applyAnswer(
        this.llm,
        {
          content,
          facts: readFacts(cv),
          questionId,
          fieldPath: question.fieldPath,
          question: question.question,
          answer: question.answer,
          targetRole: cv.targetRole,
        },
        job.signal,
      );
      if (this.supersededBy(job)) return 'superseded';
      this.logRemoved(result.removed);

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
      return this.onJobError(err, job, record);
    }
    return 'done';
  }

  // -------------------------------------------------------------------------

  /**
   * Runs one job attempt with its ids in the log context (so every line inside,
   * including each `llm_call`, carries them) and logs how it ended.
   */
  private runJob(
    queue: QueueName,
    ids: Record<string, string>,
    job: { retryCount: number; retryLimit: number },
    fn: () => Promise<JobOutcome>,
  ): Promise<void> {
    // `jobAttempt`, not `attempt`: llm_call lines have their own attempt (first try or repair).
    return withLogContext({ queue, ...ids, jobAttempt: job.retryCount + 1 }, async () => {
      const started = Date.now();
      let outcome: JobOutcome | 'will_retry' = 'will_retry';
      try {
        outcome = await fn();
      } finally {
        this.logger.log({ msg: `job ${outcome}`, event: 'job_finished', outcome, durationMs: Date.now() - started });
      }
    });
  }

  /** What the grounding checks removed: the most useful line when a CV looks thinner than expected. */
  private logRemoved(removed: string[]) {
    if (removed.length)
      this.logger.log({ msg: 'grounding removed content', event: 'grounding_removed', count: removed.length, removed });
  }

  /**
   * Non-retryable errors (bad input, auth) fail immediately with a readable
   * message. Retryable ones are rethrown so pg-boss retries with backoff; the
   * last attempt records the failure for the user.
   */
  private async onJobError(
    err: unknown,
    job: { retryCount: number; retryLimit: number; signal?: AbortSignal },
    record: (message: string, final: boolean) => Promise<void>,
  ): Promise<JobOutcome> {
    if (job.signal?.aborted) {
      if (this.supersededBy(job)) return 'superseded';
      // The last attempt expired: pg-boss won't retry it, so nobody else will record the failure.
      this.logger.warn({
        msg: 'job aborted on its last attempt',
        event: 'job_aborted',
        reason: String(job.signal.reason),
      });
      await record(TOOK_TOO_LONG, true);
      return 'failed';
    }
    const llmError = err instanceof LlmError ? err : null;
    const retryable = llmError ? llmError.retryable : true;
    const final = !retryable || job.retryCount >= job.retryLimit;
    const message = llmError?.message ?? 'Something went wrong while processing your CV.';

    this.logger.error({
      msg: final ? 'job failed' : 'job attempt failed, will retry',
      event: 'job_error',
      final,
      retryable,
      maxAttempts: job.retryLimit + 1,
      userMessage: message,
      err,
    });
    await record(message, final);
    if (!final) throw err;
    return 'failed';
  }

  /**
   * True when pg-boss aborted this attempt and will retry it: a newer attempt may
   * already be running, so this one must not write anything. On the last
   * attempt nobody else will, so it still records its outcome.
   */
  private supersededBy(job: { retryCount: number; retryLimit: number; signal?: AbortSignal }): boolean {
    if (!job.signal?.aborted || job.retryCount >= job.retryLimit) return false;
    this.logger.warn({
      msg: 'job attempt aborted, leaving it to the retry',
      event: 'job_superseded',
      reason: String(job.signal.reason),
    });
    return true;
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
      if (stale.length)
        this.logger.warn({ msg: 're-enqueued stale CV jobs', event: 'sweep_requeued', count: stale.length });
    } catch (err) {
      this.logger.error(`Sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
