import type { CvDetail } from '@cv/shared';
import { LlmError } from '../src/ai/cv-llm.js';
import { JOB_EXPIRE_SECONDS, QueueService } from '../src/queue/queue.service.js';
import { logContext } from '../src/common/log-context.js';
import { composition, extraction, resetFakeLlm } from '../src/testing/fixtures.js';
import {
  createCv,
  createReadyCv,
  createTestApp,
  jobsFor,
  runAnswerJob,
  runGenerateJob,
  signUp,
  type Agent,
  type TestContext,
} from './helpers.js';

describe('background jobs (e2e)', () => {
  let ctx: TestContext;
  let user: Agent;
  beforeAll(async () => {
    ctx = await createTestApp();
    user = await signUp(ctx.app);
  });
  afterAll(() => ctx.app.close());
  afterEach(() => resetFakeLlm(ctx.llm));

  const getCv = async (id: string) => (await user.get(`/api/cvs/${id}`).expect(200)).body as CvDetail;

  describe('generation', () => {
    it('records the progress step while the job runs', async () => {
      const cv = await createCv(user);
      const seen: (string | null)[] = [];
      ctx.llm.composeCv.mockImplementation(async () => {
        const row = await getCv(cv.id);
        seen.push(row.status, row.progressStep);
        return composition();
      });

      await runGenerateJob(ctx, cv.id);

      expect(seen).toEqual(['processing', 'writing']);
      expect(await getCv(cv.id)).toMatchObject({ status: 'ready', progressStep: null, error: null });
    });

    it('runs model calls inside the job’s log context, through the Mastra workflow', async () => {
      const cv = await createCv(user);
      const seen: Record<string, unknown>[] = [];
      ctx.llm.extractFacts.mockImplementation(async () => {
        seen.push(logContext());
        return extraction();
      });
      ctx.llm.composeCv.mockImplementation(async () => {
        seen.push(logContext());
        return composition();
      });

      await runGenerateJob(ctx, cv.id, { retryCount: 1, retryLimit: 2 });

      expect(seen).toEqual([
        { queue: 'generate-cv', cvId: cv.id, jobAttempt: 2 },
        { queue: 'generate-cv', cvId: cv.id, jobAttempt: 2 },
      ]);
    });

    it('rethrows a retryable failure so pg-boss retries, and tells the user', async () => {
      const cv = await createCv(user);
      ctx.llm.composeCv.mockRejectedValue(new LlmError('The AI service is temporarily unavailable.', true));

      await expect(runGenerateJob(ctx, cv.id, { retryCount: 0, retryLimit: 2 })).rejects.toBeInstanceOf(LlmError);

      expect(await getCv(cv.id)).toMatchObject({
        status: 'processing',
        error: 'The AI service is temporarily unavailable. Retrying…',
      });
    });

    it('marks the CV failed with a readable error once retries are exhausted', async () => {
      const cv = await createCv(user);
      ctx.llm.composeCv.mockRejectedValue(new LlmError('The AI service is temporarily unavailable.', true));

      await runGenerateJob(ctx, cv.id, { retryCount: 2, retryLimit: 2 });

      expect(await getCv(cv.id)).toMatchObject({
        status: 'failed',
        progressStep: null,
        error: 'The AI service is temporarily unavailable.',
      });
    });

    it('fails immediately, without retrying, on a non-retryable error', async () => {
      const cv = await createCv(user);
      ctx.llm.extractFacts.mockResolvedValue({ facts: [], gaps: [] });

      await runGenerateJob(ctx, cv.id, { retryCount: 0, retryLimit: 2 });

      expect((await getCv(cv.id)).status).toBe('failed');
      expect(ctx.llm.composeCv).not.toHaveBeenCalled();
    });

    it('never exposes internal error details', async () => {
      const cv = await createCv(user);
      ctx.llm.extractFacts.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.3:5432 password=hunter2'));

      await runGenerateJob(ctx, cv.id, { retryCount: 2, retryLimit: 2 });

      expect((await getCv(cv.id)).error).toBe('Generation failed.');
    });

    it('lets the user retry a failed CV, which enqueues a fresh job', async () => {
      const cv = await createCv(user);
      ctx.llm.extractFacts.mockResolvedValue({ facts: [], gaps: [] });
      await runGenerateJob(ctx, cv.id);
      // The job finished (pg-boss marks it completed once the handler returns).
      await ctx.prisma.$executeRaw`UPDATE pgboss.job SET state = 'completed' WHERE singleton_key = ${cv.id}`;

      const retried = (await user.post(`/api/cvs/${cv.id}/retry`).expect(200)).body as CvDetail;

      expect(retried).toMatchObject({ status: 'queued', error: null });
      expect((await jobsFor(ctx.prisma, cv.id))[0]).toEqual({ name: 'generate-cv', state: 'created' });

      resetFakeLlm(ctx.llm);
      await runGenerateJob(ctx, cv.id);
      expect((await getCv(cv.id)).status).toBe('ready');
    });

    it('only allows retrying failed CVs', async () => {
      const cv = await createReadyCv(ctx, user);
      await user.post(`/api/cvs/${cv.id}/retry`).expect(409);
    });

    it('does not enqueue a duplicate while a job for the CV is pending', async () => {
      const cv = await createCv(user);
      const queue = ctx.app.get(QueueService);

      expect(await queue.send('generate-cv', { cvId: cv.id }, cv.id)).toBeNull();
      expect(await jobsFor(ctx.prisma, cv.id)).toHaveLength(1);
    });

    it('applies queue options to queues that already exist', async () => {
      // As if the queue had been created by an older build with a shorter expiry.
      await ctx.prisma.$executeRaw`UPDATE pgboss.queue SET expire_seconds = 60, retry_limit = 0`;

      const rebooted = await createTestApp();
      await rebooted.app.close();

      const queues = await ctx.prisma.$queryRaw<{ name: string; expire_seconds: number; retry_limit: number }[]>`
        SELECT name, expire_seconds, retry_limit FROM pgboss.queue WHERE name IN ('generate-cv', 'apply-answer') ORDER BY name`;
      expect(queues).toEqual([
        { name: 'apply-answer', expire_seconds: JOB_EXPIRE_SECONDS, retry_limit: 2 },
        { name: 'generate-cv', expire_seconds: JOB_EXPIRE_SECONDS, retry_limit: 2 },
      ]);
    });

    it('is a no-op for a job whose CV is already ready or deleted', async () => {
      const cv = await createReadyCv(ctx, user);
      ctx.llm.extractFacts.mockClear();
      await runGenerateJob(ctx, cv.id);
      await runGenerateJob(ctx, '00000000-0000-4000-8000-000000000000');
      expect(ctx.llm.extractFacts).not.toHaveBeenCalled();
    });
  });

  describe('expired attempts (job.signal aborted)', () => {
    /** The model call during which pg-boss gives up on the attempt. */
    const expireDuring = (ac: AbortController, outcome: 'throws' | 'finishes') => async () => {
      ac.abort(new Error('handler execution exceeded 900s'));
      if (outcome === 'throws') throw new LlmError('The AI request was cancelled.', true);
      return composition();
    };

    it('passes the signal to every model call', async () => {
      const cv = await createCv(user);
      const ac = new AbortController();
      await runGenerateJob(ctx, cv.id, { retryCount: 0, retryLimit: 2, signal: ac.signal });
      expect(ctx.llm.extractFacts.mock.calls[0][1]).toBe(ac.signal);
      expect(ctx.llm.composeCv.mock.calls[0][1]).toBe(ac.signal);
    });

    it('writes nothing when a retry will take over', async () => {
      const cv = await createCv(user);
      const ac = new AbortController();
      ctx.llm.composeCv.mockImplementation(expireDuring(ac, 'throws'));

      // Resolves rather than rethrowing: pg-boss has already settled this attempt.
      await runGenerateJob(ctx, cv.id, { retryCount: 0, retryLimit: 2, signal: ac.signal });

      expect(await getCv(cv.id)).toMatchObject({ status: 'processing', error: null });
    });

    it('does not save a result that arrives after the attempt was aborted', async () => {
      const cv = await createCv(user);
      const ac = new AbortController();
      ctx.llm.composeCv.mockImplementation(expireDuring(ac, 'finishes'));

      await runGenerateJob(ctx, cv.id, { retryCount: 0, retryLimit: 2, signal: ac.signal });

      expect(await getCv(cv.id)).toMatchObject({ status: 'processing', content: null, version: 0 });
    });

    it('marks the CV failed when the last attempt expires', async () => {
      const cv = await createCv(user);
      const ac = new AbortController();
      ctx.llm.composeCv.mockImplementation(expireDuring(ac, 'throws'));

      await runGenerateJob(ctx, cv.id, { retryCount: 2, retryLimit: 2, signal: ac.signal });

      expect(await getCv(cv.id)).toMatchObject({ status: 'failed', error: 'This took too long. Please try again.' });
    });

    it('still saves a last attempt that finished just after expiring', async () => {
      const cv = await createCv(user);
      const ac = new AbortController();
      ctx.llm.composeCv.mockImplementation(expireDuring(ac, 'finishes'));

      await runGenerateJob(ctx, cv.id, { retryCount: 2, retryLimit: 2, signal: ac.signal });

      expect((await getCv(cv.id)).status).toBe('ready');
    });

    it('leaves an aborted answer for its retry', async () => {
      const cv = await createReadyCv(ctx, user);
      const ac = new AbortController();
      ctx.llm.applyAnswer.mockImplementation(async (_input, signal) => {
        expect(signal).toBe(ac.signal);
        ac.abort();
        throw new LlmError('The AI request was cancelled.', true);
      });

      await user.post(`/api/cvs/${cv.id}/questions/${cv.questions[0].id}/answer`).send({ answer: 'x' }).expect(200);
      await runAnswerJob(ctx, cv.questions[0].id, { retryCount: 0, retryLimit: 2, signal: ac.signal });

      expect((await getCv(cv.id)).questions[0]).toMatchObject({ applying: true, error: null });
    });
  });

  describe('answering questions', () => {
    const answerUrl = (cv: CvDetail) => `/api/cvs/${cv.id}/questions/${cv.questions[0].id}/answer`;
    /** The Globex entry as the model would rewrite it, citing the answer fact. */
    const globexWithAnswer = (answerFactId: string) => ({
      ...composition().experience[1],
      bullets: [{ text: 'Automated 3 release pipelines', factIds: [answerFactId] }],
    });

    it('applies an answer to its section as a background job', async () => {
      const cv = await createReadyCv(ctx, user);
      ctx.llm.applyAnswer.mockImplementation(async (input) => globexWithAnswer(input.answerFactId));

      const pending = await user.post(answerUrl(cv)).send({ answer: 'I automated 3 release pipelines.' }).expect(200);
      expect(pending.body).toMatchObject({ applying: true, answer: 'I automated 3 release pipelines.' });
      expect((await jobsFor(ctx.prisma, cv.questions[0].id))[0]?.name).toBe('apply-answer');
      await user.post(answerUrl(cv)).send({ answer: 'again' }).expect(409);

      await runAnswerJob(ctx, cv.questions[0].id);

      const after = await getCv(cv.id);
      expect(after.version).toBe(cv.version + 1);
      expect(after.questions[0]).toMatchObject({ status: 'answered', applying: false, error: null });
      expect(after.content?.experience[1].bullets.map((b) => b.text)).toEqual(['Automated 3 release pipelines']);
      expect(after.content?.experience[0]).toEqual(cv.content?.experience[0]);
    });

    it('keeps manual edits made while the answer was being applied', async () => {
      const cv = await createReadyCv(ctx, user);
      ctx.llm.applyAnswer.mockImplementation(async (input) => {
        // The user edits the summary while the model is working.
        await user
          .put(`/api/cvs/${cv.id}/content`)
          .send({ version: cv.version, content: { ...cv.content!, summary: 'Edited meanwhile' } })
          .expect(200);
        return globexWithAnswer(input.answerFactId);
      });

      await user.post(answerUrl(cv)).send({ answer: 'I automated 3 release pipelines.' }).expect(200);
      await runAnswerJob(ctx, cv.questions[0].id);

      const after = await getCv(cv.id);
      expect(after.content?.summary).toBe('Edited meanwhile');
      expect(after.content?.experience[1].bullets[0].text).toBe('Automated 3 release pipelines');
      expect(after.version).toBe(cv.version + 2);
    });

    it('records a final failure on the question and lets the user try again', async () => {
      const cv = await createReadyCv(ctx, user);
      ctx.llm.applyAnswer.mockRejectedValue(new LlmError('The AI took too long to respond.', true));

      await user.post(answerUrl(cv)).send({ answer: 'Something' }).expect(200);
      await expect(runAnswerJob(ctx, cv.questions[0].id, { retryCount: 0, retryLimit: 2 })).rejects.toThrow();
      expect((await getCv(cv.id)).questions[0]).toMatchObject({
        applying: true,
        error: 'The AI took too long to respond. Retrying…',
      });

      await runAnswerJob(ctx, cv.questions[0].id, { retryCount: 2, retryLimit: 2 });
      const after = await getCv(cv.id);
      expect(after.questions[0]).toMatchObject({
        status: 'open',
        applying: false,
        error: 'The AI took too long to respond.',
      });
      expect(after.version).toBe(cv.version);
    });

    it('can dismiss a question', async () => {
      const cv = await createReadyCv(ctx, user);
      const res = await user.post(`/api/cvs/${cv.id}/questions/${cv.questions[0].id}/dismiss`).expect(200);
      expect(res.body.status).toBe('dismissed');
    });
  });
});
