import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { CvDocument } from '@cv/shared';
import type { Cv } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QUEUES, QueueService } from '../queue/queue.service.js';

export interface NewCvInput {
  targetRole: string;
  sourceType: 'pdf' | 'text';
  sourceText: string;
  title?: string;
}

/**
 * All CV access goes through here and is scoped by userId: another user's CV
 * is indistinguishable from a missing one (404).
 */
@Injectable()
export class CvsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  list(userId: string) {
    return this.prisma.cv.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' }, take: 200 });
  }

  async getOwned(userId: string, id: string): Promise<Cv> {
    const cv = await this.prisma.cv.findFirst({ where: { id, userId } });
    if (!cv) throw new NotFoundException('CV not found');
    return cv;
  }

  async getDetail(userId: string, id: string) {
    const cv = await this.getOwned(userId, id);
    const questions = await this.prisma.cvQuestion.findMany({
      where: { cvId: cv.id },
      orderBy: { createdAt: 'asc' },
    });
    return { cv, questions };
  }

  /** Creates the CV and enqueues generation atomically: no CV without a job, no job without a CV. */
  create(userId: string, input: NewCvInput): Promise<Cv> {
    return this.prisma.$transaction(async (tx) => {
      const cv = await tx.cv.create({
        data: {
          userId,
          title: input.title ?? `${input.targetRole} CV`,
          targetRole: input.targetRole,
          sourceType: input.sourceType,
          sourceText: input.sourceText,
          status: 'queued',
        },
      });
      await this.queue.send(QUEUES.generate, { cvId: cv.id }, cv.id, tx);
      return cv;
    });
  }

  async retry(userId: string, id: string): Promise<Cv> {
    const cv = await this.getOwned(userId, id);
    if (cv.status !== 'failed') throw new ConflictException('Only a failed generation can be retried');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.cv.update({
        where: { id: cv.id },
        data: { status: 'queued', error: null, progressStep: null },
      });
      await this.queue.send(QUEUES.generate, { cvId: cv.id }, cv.id, tx);
      return updated;
    });
  }

  async rename(userId: string, id: string, title: string): Promise<Cv> {
    await this.getOwned(userId, id);
    return this.prisma.cv.update({ where: { id }, data: { title } });
  }

  /**
   * Manual edit with optimistic locking: the write only succeeds if nobody
   * (another tab/device, or an answer being applied) changed the CV since the
   * client loaded `version`.
   */
  async updateContent(userId: string, id: string, version: number, content: CvDocument): Promise<Cv> {
    const cv = await this.getOwned(userId, id);
    if (cv.status !== 'ready') throw new ConflictException('The CV is not ready for editing yet');
    const { count } = await this.prisma.cv.updateMany({
      where: { id, userId, version },
      data: { content, version: { increment: 1 } },
    });
    if (count === 0) {
      throw new ConflictException('This CV was changed elsewhere. Reload to get the latest version.');
    }
    return this.getOwned(userId, id);
  }

  async remove(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.cv.deleteMany({ where: { id, userId } });
    if (count === 0) throw new NotFoundException('CV not found');
  }
}
