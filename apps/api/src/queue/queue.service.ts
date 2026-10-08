import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PgBoss, fromPrisma, type Job, type JobWithMetadata } from 'pg-boss';
import { MAX_ATTEMPTS_PER_CALL } from '../ai/cv-llm.js';
import { config } from '../config.js';

export const QUEUES = {
  generate: 'generate-cv',
  applyAnswer: 'apply-answer',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export type TxLike = Parameters<typeof fromPrisma>[0];

/** The most LLM calls one job makes: generation extracts, then composes (applying an answer makes one). */
const LLM_CALLS_PER_JOB = 2;

/**
 * A job must outlive its slowest possible run, or pg-boss fails and retries it
 * while the first run is still going. Mastra's `timeout.totalMs` caps each
 * agent.generate() including its provider retries, so the worst case is
 * calls x attempts x timeout (12 min at the default 180 s), plus a margin.
 */
export function jobExpireSeconds(llmTimeoutMs: number): number {
  return Math.ceil((LLM_CALLS_PER_JOB * MAX_ATTEMPTS_PER_CALL * llmTimeoutMs) / 1000) + 3 * 60;
}

export const JOB_EXPIRE_SECONDS = jobExpireSeconds(config.llmTimeoutMs);

const QUEUE_OPTIONS = { retryLimit: 2, retryDelay: 5, retryBackoff: true, expireInSeconds: JOB_EXPIRE_SECONDS };

/**
 * Durable background jobs on the same Postgres (pg-boss). Jobs survive
 * restarts; a crashed worker's job expires and is retried. `exclusive` +
 * singletonKey guarantees at most one queued/active job per CV / question.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly boss = new PgBoss({ connectionString: config.databaseUrl, schema: 'pgboss' });

  async onModuleInit() {
    this.boss.on('error', (err) => this.logger.error(`pg-boss: ${err.message}`));
    await this.boss.start();
    for (const name of Object.values(QUEUES)) {
      // Options live in the database: apply them to existing queues too, so a changed
      // LLM_TIMEOUT_MS (and with it the expiry) takes effect on the next boot.
      if (await this.boss.getQueue(name)) {
        await this.boss.updateQueue(name, QUEUE_OPTIONS);
        continue;
      }
      try {
        await this.boss.createQueue(name, { policy: 'exclusive', ...QUEUE_OPTIONS });
      } catch (err) {
        // Another instance created it first.
        if (!/already exists/i.test(String(err))) throw err;
        await this.boss.updateQueue(name, QUEUE_OPTIONS);
      }
    }
  }

  async onModuleDestroy() {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }

  /** Enqueue; pass `tx` to make the enqueue part of a Prisma transaction. */
  send(name: QueueName, data: object, singletonKey: string, tx?: TxLike): Promise<string | null> {
    return this.boss.send(name, data, { singletonKey, ...(tx ? { db: fromPrisma(tx) } : {}) });
  }

  work<T>(name: QueueName, handler: (job: JobWithMetadata<T>) => Promise<void>): Promise<string> {
    const options = { includeMetadata: true, batchSize: 1 } as const;
    return this.boss.work<T, void, typeof options>(name, options, async (jobs: JobWithMetadata<T>[]) => {
      for (const job of jobs) await handler(job);
    });
  }
}

export type { Job };
