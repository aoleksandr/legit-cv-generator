import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getStorageToken } from '@nestjs/throttler';
import type { CvDetail } from '@cv/shared';
import request from 'supertest';
import { CV_LLM } from '../src/ai/cv-llm.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { GenerationService } from '../src/generation/generation.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { fakeLlm, SOURCE_TEXT, TARGET_ROLE, type FakeLlm } from '../src/testing/fixtures.js';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  generation: GenerationService;
  llm: FakeLlm;
}

/** Never counts a hit: specs create many CVs from one IP, well past the real limits. */
const noThrottling = {
  increment: async () => ({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
};

/**
 * The real AppModule against the test database, with only the LLM replaced.
 * Rate limiting is off unless `throttle` is set.
 */
export async function createTestApp({ throttle = false } = {}): Promise<TestContext> {
  const llm = fakeLlm();
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CV_LLM)
    .useValue(llm);
  if (!throttle) builder = builder.overrideProvider(getStorageToken()).useValue(noThrottling);
  const moduleRef = await builder.compile();
  const app = configureApp(
    moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      // Expected job failures log stack traces; run with DEBUG=1 to see them.
      logger: process.env.DEBUG ? undefined : false,
    }),
  );
  await app.init();
  return { app, prisma: app.get(PrismaService), generation: app.get(GenerationService), llm };
}

let counter = 0;
/** A signed-in supertest agent (it keeps the session cookie). */
export async function signUp(app: INestApplication, email = `user${Date.now()}_${counter++}@example.com`) {
  const agent = request.agent(app.getHttpServer());
  await agent.post('/api/auth/signup').send({ email, password: 'correct horse battery' }).expect(201);
  return agent;
}

export type Agent = Awaited<ReturnType<typeof signUp>>;

export async function createCv(agent: Agent): Promise<CvDetail> {
  const res = await agent.post('/api/cvs').send({ targetRole: TARGET_ROLE, text: SOURCE_TEXT }).expect(201);
  return res.body as CvDetail;
}

export interface Attempt {
  retryCount: number;
  retryLimit: number;
  /** pg-boss aborts it when the job expires or the worker shuts down. */
  signal?: AbortSignal;
}

/** What the pg-boss worker would do: run the generate job once. */
export function runGenerateJob(ctx: TestContext, cvId: string, attempt: Attempt = { retryCount: 0, retryLimit: 2 }) {
  return ctx.generation.handleGenerate({ data: { cvId }, ...attempt });
}

export function runAnswerJob(
  ctx: TestContext,
  questionId: string,
  attempt: Attempt = { retryCount: 0, retryLimit: 2 },
) {
  return ctx.generation.handleApplyAnswer({ data: { questionId }, ...attempt });
}

/** A CV that went through generation with the fake LLM. */
export async function createReadyCv(ctx: TestContext, agent: Agent): Promise<CvDetail> {
  const cv = await createCv(agent);
  await runGenerateJob(ctx, cv.id);
  return (await agent.get(`/api/cvs/${cv.id}`).expect(200)).body as CvDetail;
}

/** pg-boss jobs for a CV / question, newest first. */
export async function jobsFor(prisma: PrismaService, singletonKey: string) {
  return prisma.$queryRaw<{ name: string; state: string }[]>`
    SELECT name, state::text FROM pgboss.job WHERE singleton_key = ${singletonKey} ORDER BY created_on DESC`;
}
