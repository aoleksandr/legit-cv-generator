import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CvsService } from '../cvs/cvs.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QUEUES, QueueService } from '../queue/queue.service.js';

@Injectable()
export class QuestionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cvs: CvsService,
    private readonly queue: QueueService,
  ) {}

  private async getOwned(userId: string, cvId: string, questionId: string) {
    const cv = await this.cvs.getOwned(userId, cvId);
    const question = await this.prisma.cvQuestion.findFirst({ where: { id: questionId, cvId: cv.id } });
    if (!question) throw new NotFoundException('Question not found');
    return { cv, question };
  }

  /** Stores the answer and enqueues a job that applies it to the relevant part of the CV. */
  async answer(userId: string, cvId: string, questionId: string, answer: string) {
    const { cv, question } = await this.getOwned(userId, cvId, questionId);
    if (cv.status !== 'ready') throw new ConflictException('The CV is not ready yet');
    if (question.applying) throw new ConflictException('This answer is already being applied');

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.cvQuestion.update({
        where: { id: question.id },
        data: { answer, applying: true, error: null },
      });
      await this.queue.send(QUEUES.applyAnswer, { questionId: question.id }, question.id, tx);
      return updated;
    });
  }

  async dismiss(userId: string, cvId: string, questionId: string) {
    const { question } = await this.getOwned(userId, cvId, questionId);
    if (question.applying) throw new ConflictException('This answer is being applied');
    return this.prisma.cvQuestion.update({ where: { id: question.id }, data: { status: 'dismissed' } });
  }
}
