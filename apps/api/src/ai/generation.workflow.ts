import { createStep, createWorkflow } from '@mastra/core/workflows';
import {
  CvDocumentSchema,
  FactSchema,
  formatFieldPath,
  parseFieldPath,
  type CvDocument,
  type Fact,
  type ProgressStep,
} from '@cv/shared';
import { z } from 'zod';
import { LlmError, type CvLlm } from './cv-llm.js';
import { verifyCv, verifyFacts, type Issue } from './grounding.js';
import type { CompositionOutput, ExtractionOutput } from './llm-schemas.js';

export const MAX_QUESTIONS = 10;

export interface GenerationResult {
  content: CvDocument;
  facts: Fact[];
  questions: Issue[];
  /** What the grounding checks removed; logged, useful for debugging. */
  removed: string[];
}

const InputSchema = z.object({ sourceText: z.string(), targetRole: z.string() });
const FactsSchema = z.array(FactSchema);
const IssueSchema = z.object({ fieldPath: z.string(), question: z.string() });
const ExtractedSchema = InputSchema.extend({ extraction: z.custom<ExtractionOutput>() });
const VerifiedSchema = z.object({
  facts: FactsSchema,
  gaps: z.array(IssueSchema),
  targetRole: z.string(),
  rejected: z.array(z.string()),
});
const DraftedSchema = VerifiedSchema.extend({ draft: z.custom<CompositionOutput>() });

/**
 * The generation pipeline as a Mastra workflow:
 *   extract facts (LLM) -> verify quotes (code) -> compose CV (LLM) -> verify CV (code)
 * The composer never sees the raw source, only facts that passed verification.
 */
export function buildGenerationWorkflow(
  llm: CvLlm,
  onProgress: (step: ProgressStep) => Promise<void>,
  failure: { error?: unknown } = {},
) {
  // Mastra serialises step errors, losing the LlmError class (and its `retryable` flag),
  // so each step records the original error for runGeneration to rethrow.
  const guard =
    <I, O>(fn: (args: { inputData: I }) => Promise<O>) =>
    async (args: { inputData: I }): Promise<O> => {
      try {
        return await fn(args);
      } catch (err) {
        failure.error = err;
        throw err;
      }
    };

  const extract = createStep({
    id: 'extract-facts',
    inputSchema: InputSchema,
    outputSchema: ExtractedSchema,
    execute: guard(async ({ inputData }) => {
      await onProgress('extracting');
      const extraction = await llm.extractFacts(inputData);
      return { extraction, ...inputData };
    }),
  });

  const verifyQuotes = createStep({
    id: 'verify-facts',
    inputSchema: ExtractedSchema,
    outputSchema: VerifiedSchema,
    execute: guard(async ({ inputData }) => {
      await onProgress('verifying');
      const candidates = inputData.extraction.facts.flatMap((f) => {
        const parsed = FactSchema.safeParse({ ...f, origin: 'source' });
        return parsed.success ? [parsed.data] : [];
      });
      const { verified, rejected } = verifyFacts(candidates, inputData.sourceText);
      if (verified.length === 0) {
        throw new LlmError(
          "We couldn't find any CV information in what you provided. Please add details about your experience, education or skills.",
          false,
        );
      }
      return {
        facts: verified,
        gaps: inputData.extraction.gaps,
        targetRole: inputData.targetRole,
        rejected: rejected.map((r) => `fact ${r.fact.id} (${r.reason}): ${r.fact.text}`),
      };
    }),
  });

  const compose = createStep({
    id: 'compose-cv',
    inputSchema: VerifiedSchema,
    outputSchema: DraftedSchema,
    execute: guard(async ({ inputData }) => {
      await onProgress('writing');
      const draft = await llm.composeCv({ facts: inputData.facts, targetRole: inputData.targetRole });
      return { ...inputData, draft };
    }),
  });

  const verifyDraft = createStep({
    id: 'verify-cv',
    inputSchema: DraftedSchema,
    outputSchema: z.custom<GenerationResult>(),
    execute: guard(async ({ inputData }) => {
      await onProgress('checking');
      const document = toCvDocument(inputData.draft);
      const { cv, issues, removed } = verifyCv(document, inputData.facts);
      const gaps = inputData.gaps.flatMap((g) => normaliseIssue(g, cv));
      return {
        content: cv,
        facts: inputData.facts,
        questions: mergeQuestions(gaps, issues).slice(0, MAX_QUESTIONS),
        removed: [...inputData.rejected, ...removed],
      } satisfies GenerationResult;
    }),
  });

  return createWorkflow({
    id: 'generate-cv',
    inputSchema: InputSchema,
    outputSchema: z.custom<GenerationResult>(),
  })
    .then(extract)
    .then(verifyQuotes)
    .then(compose)
    .then(verifyDraft)
    .commit();
}

export async function runGeneration(
  llm: CvLlm,
  input: { sourceText: string; targetRole: string },
  onProgress: (step: ProgressStep) => Promise<void> = async () => {},
): Promise<GenerationResult> {
  const failure: { error?: unknown } = {};
  const workflow = buildGenerationWorkflow(llm, onProgress, failure);
  const run = await workflow.createRun();
  const result = await run.start({ inputData: input });
  if (result.status === 'success') return result.result as GenerationResult;
  if (result.status === 'failed') {
    const err = failure.error ?? result.error;
    // Unexpected errors keep their details in `cause` (logged), not in the user-facing message.
    throw err instanceof LlmError ? err : new LlmError('Generation failed.', true, { cause: err });
  }
  throw new LlmError(`Generation ended unexpectedly (${result.status}).`, true);
}

// ---------------------------------------------------------------------------
// Converting untrusted model output into a valid CvDocument
// ---------------------------------------------------------------------------

const clamp = (s: unknown, max: number) => (typeof s === 'string' ? s.trim().slice(0, max) : '');

/** Clamp, assign ids, and validate against the strict shared schema. */
export function toCvDocument(draft: CompositionOutput): CvDocument {
  const usedIds = new Set<string>();
  const entryId = (raw: string, prefix: string, index: number) => {
    let id = /^[\w-]{1,64}$/.test(raw) ? raw : `${prefix}_${index + 1}`;
    while (usedIds.has(id)) id = `${id}_x`;
    usedIds.add(id);
    return id;
  };

  const doc = {
    contact: {
      fullName: clamp(draft.contact?.fullName, 200),
      email: clamp(draft.contact?.email, 200),
      phone: clamp(draft.contact?.phone, 200),
      location: clamp(draft.contact?.location, 200),
      links: (draft.contact?.links ?? [])
        .map((l) => clamp(l, 300))
        .filter(Boolean)
        .slice(0, 10),
    },
    summary: clamp(draft.summary, 2000),
    experience: (draft.experience ?? []).slice(0, 50).map((e, i) => {
      const id = entryId(e.id, 'exp', i);
      return {
        id,
        title: clamp(e.title, 200),
        company: clamp(e.company, 200),
        location: clamp(e.location, 200),
        startDate: clamp(e.startDate, 200),
        endDate: clamp(e.endDate, 200),
        bullets: (e.bullets ?? [])
          .slice(0, 30)
          .map((b, j) => ({
            id: `${id}_b${j + 1}`,
            text: clamp(b.text, 500),
            factIds: (b.factIds ?? []).filter((f) => typeof f === 'string').slice(0, 20),
          }))
          .filter((b) => b.text),
      };
    }),
    education: (draft.education ?? []).slice(0, 20).map((e, i) => ({
      id: entryId(e.id, 'edu', i),
      institution: clamp(e.institution, 200),
      degree: clamp(e.degree, 200),
      field: clamp(e.field, 200),
      startDate: clamp(e.startDate, 200),
      endDate: clamp(e.endDate, 200),
      details: clamp(e.details, 1000),
    })),
    skills: (draft.skills ?? [])
      .map((s) => clamp(s, 100))
      .filter(Boolean)
      .slice(0, 100),
  };

  const parsed = CvDocumentSchema.safeParse(doc);
  if (!parsed.success) {
    throw new LlmError('The AI returned a CV in an unexpected shape. Please try again.', true, { cause: parsed.error });
  }
  return parsed.data;
}

/** Validate a model-proposed field path; fall back to the section when the entry doesn't exist. */
function normaliseIssue(issue: { fieldPath: string; question: string }, cv: CvDocument): Issue[] {
  const question = clamp(issue.question, 500);
  const path = parseFieldPath(String(issue.fieldPath).trim());
  if (!question || !path) return [];
  if (path.entryId) {
    const exists = cv[path.section].some((e) => e.id === path.entryId);
    if (!exists) return [{ fieldPath: path.section, question }];
  }
  return [{ fieldPath: formatFieldPath(path), question }];
}

/** Gaps from extraction first (they're the model's judgement of what matters), then verification issues. */
function mergeQuestions(gaps: Issue[], issues: Issue[]): Issue[] {
  const seenPaths = new Map<string, number>();
  const out: Issue[] = [];
  for (const q of [...gaps, ...issues]) {
    const count = seenPaths.get(q.fieldPath) ?? 0;
    // At most two questions per field path, to keep the list readable.
    if (count >= 2) continue;
    seenPaths.set(q.fieldPath, count + 1);
    out.push(q);
  }
  return out;
}
