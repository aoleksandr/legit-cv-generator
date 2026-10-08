import {
  CvDocumentSchema,
  FactSchema,
  ProgressStepSchema,
  type CvDetail,
  type CvDocument,
  type CvSummary,
  type Fact,
  type Question,
} from '@cv/shared';
import { z } from 'zod';
import type { Cv, CvQuestion } from '../generated/prisma/client.js';

export function toSummary(cv: Cv): CvSummary {
  return {
    id: cv.id,
    title: cv.title,
    targetRole: cv.targetRole,
    status: cv.status,
    createdAt: cv.createdAt.toISOString(),
    updatedAt: cv.updatedAt.toISOString(),
  };
}

export function toQuestion(q: CvQuestion): Question {
  return {
    id: q.id,
    fieldPath: q.fieldPath,
    question: q.question,
    answer: q.answer,
    status: q.status,
    applying: q.applying,
    error: q.error,
  };
}

export function toDetail(cv: Cv, questions: CvQuestion[]): CvDetail {
  const step = ProgressStepSchema.safeParse(cv.progressStep);
  return {
    ...toSummary(cv),
    sourceType: cv.sourceType,
    progressStep: step.success ? step.data : null,
    error: cv.error,
    content: readContent(cv),
    version: cv.version,
    questions: questions.map(toQuestion),
  };
}

/** Stored JSON is re-validated on read; a corrupt row degrades to "no content" instead of a crash. */
export function readContent(cv: Pick<Cv, 'content'>): CvDocument | null {
  if (cv.content == null) return null;
  const parsed = CvDocumentSchema.safeParse(cv.content);
  return parsed.success ? parsed.data : null;
}

export function readFacts(cv: Pick<Cv, 'facts'>): Fact[] {
  const parsed = z.array(FactSchema).safeParse(cv.facts);
  return parsed.success ? parsed.data : [];
}
