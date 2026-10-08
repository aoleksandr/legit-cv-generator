import {
  BadRequestException,
  ConflictException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import {
  AnswerQuestionSchema,
  CreateCvFromTextSchema,
  LIMITS,
  TargetRoleSchema,
  UpdateCvContentSchema,
  UpdateCvMetaSchema,
  type AnswerQuestion,
  type CreateCvFromText,
  type CvDetail,
  type CvSummary,
  type Question,
  type UpdateCvContent,
} from '@cv/shared';
import type { Response } from 'express';
import { UserId } from '../auth/auth.decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { IngestionService } from '../ingestion/ingestion.service.js';
import { contentDisposition, PdfService } from '../pdf/pdf.service.js';
import { QuestionsService } from '../questions/questions.service.js';
import { readContent, toDetail, toQuestion, toSummary } from './cv.mapper.js';
import { CvsService } from './cvs.service.js';

const uuid = new ParseUUIDPipe({ version: '4' });

/** Generation is the expensive call; limit how often a user can start one. */
const GENERATION_THROTTLE = { default: { limit: 10, ttl: 60 * 60_000 } };

@Controller('cvs')
export class CvsController {
  constructor(
    private readonly cvs: CvsService,
    private readonly ingestion: IngestionService,
    private readonly questions: QuestionsService,
    private readonly pdf: PdfService,
  ) {}

  @Get()
  async list(@UserId() userId: string): Promise<CvSummary[]> {
    return (await this.cvs.list(userId)).map(toSummary);
  }

  @Throttle(GENERATION_THROTTLE)
  @Post()
  async createFromText(
    @UserId() userId: string,
    @Body(new ZodPipe(CreateCvFromTextSchema)) body: CreateCvFromText,
  ): Promise<CvDetail> {
    const cv = await this.cvs.create(userId, {
      targetRole: body.targetRole,
      sourceType: 'text',
      sourceText: body.text,
    });
    return toDetail(cv, []);
  }

  @Throttle(GENERATION_THROTTLE)
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      // +1 so an oversize file reaches our check and gets a clear message instead of multer's.
      limits: { fileSize: LIMITS.pdfMaxBytes + 1, files: 1, fields: 5 },
    }),
  )
  async createFromPdf(
    @UserId() userId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('targetRole') rawRole: unknown,
  ): Promise<CvDetail> {
    const role = TargetRoleSchema.safeParse(rawRole);
    if (!role.success) throw new BadRequestException('Please provide a target role (2-120 characters)');
    if (!file) throw new BadRequestException('Please attach a PDF file in the "file" field');
    const sourceText = await this.ingestion.pdfToText(file.buffer);
    const cv = await this.cvs.create(userId, { targetRole: role.data, sourceType: 'pdf', sourceText });
    return toDetail(cv, []);
  }

  @Get(':id')
  async get(@UserId() userId: string, @Param('id', uuid) id: string): Promise<CvDetail> {
    const { cv, questions } = await this.cvs.getDetail(userId, id);
    return toDetail(cv, questions);
  }

  /** A4 PDF with selectable text, rendered from the saved content. */
  @Get(':id/pdf')
  async downloadPdf(@UserId() userId: string, @Param('id', uuid) id: string, @Res() res: Response): Promise<void> {
    const cv = await this.cvs.getOwned(userId, id);
    const content = cv.status === 'ready' ? readContent(cv) : null;
    if (!content) throw new ConflictException('The CV is not ready yet');
    const buffer = await this.pdf.render(content, cv.title);
    res
      .status(200)
      .set({
        'Content-Type': 'application/pdf',
        'Content-Length': String(buffer.length),
        'Content-Disposition': contentDisposition(
          content.contact.fullName ? `${content.contact.fullName} - ${cv.title}` : cv.title,
        ),
        'Cache-Control': 'private, no-store',
      })
      .end(buffer);
  }

  @Patch(':id')
  async rename(
    @UserId() userId: string,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(UpdateCvMetaSchema)) body: { title: string },
  ): Promise<CvSummary> {
    return toSummary(await this.cvs.rename(userId, id, body.title));
  }

  @Put(':id/content')
  async updateContent(
    @UserId() userId: string,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(UpdateCvContentSchema)) body: UpdateCvContent,
  ): Promise<CvDetail> {
    await this.cvs.updateContent(userId, id, body.version, body.content);
    const { cv, questions } = await this.cvs.getDetail(userId, id);
    return toDetail(cv, questions);
  }

  @Throttle(GENERATION_THROTTLE)
  @Post(':id/retry')
  @HttpCode(200)
  async retry(@UserId() userId: string, @Param('id', uuid) id: string): Promise<CvDetail> {
    await this.cvs.retry(userId, id);
    const { cv, questions } = await this.cvs.getDetail(userId, id);
    return toDetail(cv, questions);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@UserId() userId: string, @Param('id', uuid) id: string): Promise<void> {
    await this.cvs.remove(userId, id);
  }

  @Post(':id/questions/:questionId/answer')
  @HttpCode(200)
  async answer(
    @UserId() userId: string,
    @Param('id', uuid) id: string,
    @Param('questionId', uuid) questionId: string,
    @Body(new ZodPipe(AnswerQuestionSchema)) body: AnswerQuestion,
  ): Promise<Question> {
    return toQuestion(await this.questions.answer(userId, id, questionId, body.answer));
  }

  @Post(':id/questions/:questionId/dismiss')
  @HttpCode(200)
  async dismiss(
    @UserId() userId: string,
    @Param('id', uuid) id: string,
    @Param('questionId', uuid) questionId: string,
  ): Promise<Question> {
    return toQuestion(await this.questions.dismiss(userId, id, questionId));
  }
}
