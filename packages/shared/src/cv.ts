import { z } from 'zod';

/**
 * The CV shape. This is the single source of truth: it validates LLM output,
 * manual edits from the editor, and what the frontend renders.
 * Limits are deliberately generous for humans but cap runaway LLM output.
 */

const shortText = z.string().trim().max(200);
const id = z.string().min(1).max(64);

export const BulletSchema = z.object({
  id,
  text: z.string().trim().min(1).max(500),
  /** Facts this bullet is derived from. Empty for bullets written by the user. */
  factIds: z.array(id).max(20).default([]),
});
export type Bullet = z.infer<typeof BulletSchema>;

export const ContactSchema = z.object({
  fullName: shortText.default(''),
  email: shortText.default(''),
  phone: shortText.default(''),
  location: shortText.default(''),
  links: z.array(z.string().trim().max(300)).max(10).default([]),
});
export type Contact = z.infer<typeof ContactSchema>;

export const ExperienceItemSchema = z.object({
  id,
  title: shortText.default(''),
  company: shortText.default(''),
  location: shortText.default(''),
  /** Free-form dates as they appear in the source, e.g. "2019", "Mar 2021", "Present". */
  startDate: shortText.default(''),
  endDate: shortText.default(''),
  bullets: z.array(BulletSchema).max(30).default([]),
});
export type ExperienceItem = z.infer<typeof ExperienceItemSchema>;

export const EducationItemSchema = z.object({
  id,
  institution: shortText.default(''),
  degree: shortText.default(''),
  field: shortText.default(''),
  startDate: shortText.default(''),
  endDate: shortText.default(''),
  details: z.string().trim().max(1000).default(''),
});
export type EducationItem = z.infer<typeof EducationItemSchema>;

export const CvDocumentSchema = z.object({
  contact: ContactSchema,
  summary: z.string().trim().max(2000).default(''),
  experience: z.array(ExperienceItemSchema).max(50).default([]),
  education: z.array(EducationItemSchema).max(20).default([]),
  skills: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
});
export type CvDocument = z.infer<typeof CvDocumentSchema>;

export const emptyCvDocument = (): CvDocument => CvDocumentSchema.parse({ contact: {} });

/**
 * An atomic, verified piece of information about the candidate.
 * Every fact must be traceable: `sourceQuote` is a verbatim excerpt of the
 * source text (or of the user's answer when origin is "user_answer").
 */
export const FactCategorySchema = z.enum([
  'contact',
  'experience',
  'education',
  'skill',
  'other',
]);
export type FactCategory = z.infer<typeof FactCategorySchema>;

export const FactSchema = z.object({
  id,
  category: FactCategorySchema,
  /**
   * Groups facts about the same job or degree, e.g. "exp_1" / "edu_2".
   * Becomes the id of the corresponding ExperienceItem / EducationItem.
   */
  entry: z.string().max(64).nullable().default(null),
  text: z.string().trim().min(1).max(1000),
  sourceQuote: z.string().trim().min(1).max(2000),
  origin: z.enum(['source', 'user_answer']),
});
export type Fact = z.infer<typeof FactSchema>;

/**
 * Addresses the part of a CV a question (and its answer) is about.
 *   "contact" | "summary" | "skills" | "experience" | "education"  -> a whole section
 *   "experience:<id>" | "education:<id>"                            -> one entry
 */
export type FieldPath =
  | { section: 'contact' | 'summary' | 'skills' | 'experience' | 'education'; entryId: null }
  | { section: 'experience' | 'education'; entryId: string };

const SECTIONS = ['contact', 'summary', 'skills', 'experience', 'education'] as const;

export function parseFieldPath(path: string): FieldPath | null {
  const [section, entryId, ...rest] = path.split(':');
  if (rest.length > 0 || !(SECTIONS as readonly string[]).includes(section)) return null;
  if (entryId === undefined) return { section: section as FieldPath['section'], entryId: null };
  if ((section === 'experience' || section === 'education') && /^[\w-]{1,64}$/.test(entryId)) {
    return { section, entryId };
  }
  return null;
}

export function formatFieldPath(path: FieldPath): string {
  return path.entryId ? `${path.section}:${path.entryId}` : path.section;
}
