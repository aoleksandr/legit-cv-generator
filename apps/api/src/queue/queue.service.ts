import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PgBoss, fromPrisma, type Job, type JobWithMetadata } from 'pg-boss';
import { config } from '../config.js';

export const QUEUES = {
  generate: 'generate-cv',
  applyAnswer: 'apply-answer',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export type TxLike = Parameters<typeof fromPrisma>[0];

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
      try {
        await this.boss.createQueue(name, {
          policy: 'exclusive',
          retryLimit: 2,
          retryDelay: 5,
          retryBackoff: true,
          // Longer than the worst-case run (LLM timeout x calls); then pg-boss retries it.
          expireInSeconds: 15 * 60,
        });
      } catch (err) {
        if (!/already exists/i.test(String(err))) throw err;
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
