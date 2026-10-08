import { z } from 'zod';
import { CvDocumentSchema } from './cv.js';

export const LIMITS = {
  pdfMaxBytes: 5 * 1024 * 1024,
  sourceTextMaxChars: 30_000,
  sourceTextMinChars: 50,
  answerMaxChars: 2_000,
} as const;

export const CredentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(128),
});
export type Credentials = z.infer<typeof CredentialsSchema>;

export const UserSchema = z.object({ id: z.string(), email: z.string() });
export type User = z.infer<typeof UserSchema>;

export const TargetRoleSchema = z.string().trim().min(2).max(120);

/** Body for free-text CV creation. PDF creation uses multipart with the same `targetRole` field. */
export const CreateCvFromTextSchema = z.object({
  targetRole: TargetRoleSchema,
  text: z.string().trim().min(LIMITS.sourceTextMinChars).max(LIMITS.sourceTextMaxChars),
});
export type CreateCvFromText = z.infer<typeof CreateCvFromTextSchema>;

export const CvStatusSchema = z.enum(['queued', 'processing', 'ready', 'failed']);
export type CvStatus = z.infer<typeof CvStatusSchema>;

export const ProgressStepSchema = z.enum(['extracting', 'verifying', 'writing', 'checking', 'saving']);
export type ProgressStep = z.infer<typeof ProgressStepSchema>;

export const QuestionStatusSchema = z.enum(['open', 'answered', 'dismissed']);

export const QuestionSchema = z.object({
  id: z.string(),
  fieldPath: z.string(),
  question: z.string(),
  answer: z.string().nullable(),
  status: QuestionStatusSchema,
  /** True while the AI is applying the answer to the CV. */
  applying: z.boolean(),
  error: z.string().nullable(),
});
export type Question = z.infer<typeof QuestionSchema>;

export const CvSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  targetRole: z.string(),
  status: CvStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CvSummary = z.infer<typeof CvSummarySchema>;

export const CvDetailSchema = CvSummarySchema.extend({
  sourceType: z.enum(['pdf', 'text']),
  progressStep: ProgressStepSchema.nullable(),
  error: z.string().nullable(),
  content: CvDocumentSchema.nullable(),
  version: z.number().int(),
  questions: z.array(QuestionSchema),
});
export type CvDetail = z.infer<typeof CvDetailSchema>;

export const UpdateCvContentSchema = z.object({
  version: z.number().int().nonnegative(),
  content: CvDocumentSchema,
});
export type UpdateCvContent = z.infer<typeof UpdateCvContentSchema>;

export const UpdateCvMetaSchema = z.object({
  title: z.string().trim().min(1).max(120),
});

export const AnswerQuestionSchema = z.object({
  answer: z.string().trim().min(1).max(LIMITS.answerMaxChars),
});
export type AnswerQuestion = z.infer<typeof AnswerQuestionSchema>;

export const ApiErrorSchema = z.object({
  statusCode: z.number(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/**
 * Local development account, created by `pnpm db:seed` and offered on the login
 * page only in Vite dev mode (the production build strips it).
 */
export const DEV_TEST_USER = { email: 'test@example.com', password: 'password123' } as const;
