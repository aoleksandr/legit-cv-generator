import { parseFieldPath, type CvDocument, type Fact, type FactCategory } from '@cv/shared';
import { LlmError, type CvLlm } from './cv-llm.js';
import { toCvDocument } from './generation.workflow.js';
import { verifyCv } from './grounding.js';
import type { CompositionOutput, SectionKind } from './llm-schemas.js';

export interface ApplyAnswerResult {
  content: CvDocument;
  facts: Fact[];
  removed: string[];
}

const CATEGORY: Record<string, FactCategory> = {
  contact: 'contact',
  summary: 'other',
  skills: 'skill',
  experience: 'experience',
  education: 'education',
};

/**
 * Applies a user's answer to exactly one part of the CV.
 *
 * The answer becomes a fact (origin "user_answer", quoting itself). The
 * current content of that part is also passed as a trusted fact ("current"),
 * since it is either verified or written by the user. Only the targeted part is
 * replaced, and it goes through the same grounding checks as generation, so
 * the model can't use an answer as an excuse to invent other details.
 */
export async function applyAnswer(
  llm: CvLlm,
  input: {
    content: CvDocument;
    facts: Fact[];
    questionId: string;
    fieldPath: string;
    question: string;
    answer: string;
    targetRole: string;
  },
  signal?: AbortSignal,
): Promise<ApplyAnswerResult> {
  const path = parseFieldPath(input.fieldPath);
  if (!path) throw new LlmError(`Unknown CV field "${input.fieldPath}".`, false);

  // An answer about an entry that no longer exists (user deleted it) updates the whole section.
  const entryExists =
    path.entryId !== null &&
    input.content[path.section as 'experience' | 'education'].some((e) => e.id === path.entryId);
  const entryId = entryExists ? path.entryId : null;

  const answerFact: Fact = {
    id: `answer_${input.questionId.replace(/[^\w]/g, '').slice(0, 12)}`,
    category: CATEGORY[path.section],
    entry: entryId,
    text: input.answer,
    sourceQuote: input.answer,
    origin: 'user_answer',
  };
  const current = currentValue(input.content, path.section, entryId);
  const currentFact: Fact = {
    id: 'current',
    category: CATEGORY[path.section],
    entry: entryId,
    text: flatten(current),
    sourceQuote: flatten(current) || '-',
    origin: 'user_answer',
  };
  const facts = [...input.facts.filter((f) => f.id !== answerFact.id), answerFact];
  const promptFacts = [...facts, currentFact];

  const kind: SectionKind =
    entryId && path.section === 'experience'
      ? 'experienceEntry'
      : entryId && path.section === 'education'
        ? 'educationEntry'
        : (path.section as SectionKind);

  const value = await llm.applyAnswer(
    {
      kind,
      current: current as never,
      facts: promptFacts,
      question: input.question,
      answer: input.answer,
      answerFactId: answerFact.id,
      targetRole: input.targetRole,
    },
    signal,
  );

  // Rebuild only the targeted part, normalise it, and ground-check it in isolation.
  const draft = toDraft(input.content);
  switch (kind) {
    case 'experienceEntry':
      draft.experience = draft.experience.map((e) =>
        e.id === entryId ? { ...(value as CompositionOutput['experience'][number]), id: e.id } : e,
      );
      break;
    case 'educationEntry':
      draft.education = draft.education.map((e) =>
        e.id === entryId ? { ...(value as CompositionOutput['education'][number]), id: e.id } : e,
      );
      break;
    default:
      (draft as Record<string, unknown>)[kind] = value;
  }
  const updated = toCvDocument(draft);

  const isolated = isolate(updated, path.section, entryId);
  const { cv: checked, removed } = verifyCv(isolated, promptFacts);
  const content = merge(checked, path.section, entryId, input.content);

  return { content, facts, removed };
}

function currentValue(cv: CvDocument, section: string, entryId: string | null): unknown {
  if (entryId) return cv[section as 'experience' | 'education'].find((e) => e.id === entryId);
  return cv[section as keyof CvDocument];
}

function flatten(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flatten).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([k]) => k !== 'id' && k !== 'factIds')
      .map(([, v]) => flatten(v))
      .filter(Boolean)
      .join('\n');
  }
  return String(value);
}

function toDraft(cv: CvDocument): CompositionOutput {
  return structuredClone(cv) as unknown as CompositionOutput;
}

/** A CV containing only the targeted part, so verification ignores (trusted) user edits elsewhere. */
function isolate(cv: CvDocument, section: string, entryId: string | null): CvDocument {
  const empty: CvDocument = {
    contact: { fullName: '', email: '', phone: '', location: '', links: [] },
    summary: '',
    experience: [],
    education: [],
    skills: [],
  };
  if (section === 'contact') return { ...empty, contact: cv.contact };
  if (section === 'summary') return { ...empty, summary: cv.summary };
  if (section === 'skills') return { ...empty, skills: cv.skills };
  if (section === 'experience') {
    return { ...empty, experience: entryId ? cv.experience.filter((e) => e.id === entryId) : cv.experience };
  }
  return { ...empty, education: entryId ? cv.education.filter((e) => e.id === entryId) : cv.education };
}

function merge(checked: CvDocument, section: string, entryId: string | null, original: CvDocument): CvDocument {
  // Everything outside the targeted part comes from the original, untouched.
  const out: CvDocument = structuredClone(original);
  if (section === 'contact') out.contact = checked.contact;
  else if (section === 'summary') out.summary = checked.summary;
  else if (section === 'skills') out.skills = checked.skills;
  else if (section === 'experience') {
    out.experience = entryId
      ? original.experience.map((e) => (e.id === entryId ? (checked.experience[0] ?? e) : e))
      : checked.experience;
  } else if (section === 'education') {
    out.education = entryId
      ? original.education.map((e) => (e.id === entryId ? (checked.education[0] ?? e) : e))
      : checked.education;
  }
  return out;
}

/**
 * Copies the part of `from` addressed by `fieldPath` into `into`. Used when the
 * CV was edited while an answer was being applied: the user's newer edits win
 * everywhere except the part the answer was about.
 */
export function splicePart(into: CvDocument, from: CvDocument, fieldPath: string): CvDocument {
  const path = parseFieldPath(fieldPath);
  if (!path) return into;
  const entryId =
    path.entryId && into[path.section as 'experience' | 'education'].some((e) => e.id === path.entryId)
      ? path.entryId
      : null;
  const part = isolate(from, path.section, entryId);
  if (entryId && part[path.section as 'experience' | 'education'].length === 0) return into;
  return merge(part, path.section, entryId, into);
}
