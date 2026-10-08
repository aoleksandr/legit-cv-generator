import { z } from 'zod';

/**
 * Schemas the model is asked to produce. They are intentionally loose (no
 * length limits or defaults, which structured-output backends handle poorly).
 * Everything parsed from them is treated as untrusted and re-validated against
 * the strict @cv/shared schemas plus the grounding checks before it is stored.
 */

export const ExtractionOutputSchema = z.object({
  facts: z.array(
    z.object({
      id: z.string().describe('Unique id: f1, f2, ...'),
      category: z.enum(['contact', 'experience', 'education', 'skill', 'other']),
      entry: z
        .string()
        .nullable()
        .describe('Groups facts about the same job ("exp_1", "exp_2") or degree ("edu_1"). null otherwise.'),
      text: z.string().describe('The fact restated plainly, without adding anything.'),
      sourceQuote: z.string().describe('Exact, contiguous, verbatim excerpt from the source supporting this fact.'),
    }),
  ),
  gaps: z.array(
    z.object({
      fieldPath: z
        .string()
        .describe('"contact" | "summary" | "skills" | "experience" | "education" | "experience:<entry>" | "education:<entry>"'),
      question: z.string().describe('A short, specific question to the candidate.'),
    }),
  ),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;

const LlmBullet = z.object({
  text: z.string(),
  factIds: z.array(z.string()).describe('Ids of the facts this bullet is based on.'),
});

export const LlmExperienceSchema = z.object({
  id: z.string().describe('The entry key of the facts, e.g. "exp_1".'),
  title: z.string(),
  company: z.string(),
  location: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  bullets: z.array(LlmBullet),
});

export const LlmEducationSchema = z.object({
  id: z.string().describe('The entry key of the facts, e.g. "edu_1".'),
  institution: z.string(),
  degree: z.string(),
  field: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  details: z.string(),
});

export const LlmContactSchema = z.object({
  fullName: z.string(),
  email: z.string(),
  phone: z.string(),
  location: z.string(),
  links: z.array(z.string()),
});

export const CompositionOutputSchema = z.object({
  contact: LlmContactSchema,
  summary: z.string(),
  experience: z.array(LlmExperienceSchema),
  education: z.array(LlmEducationSchema),
  skills: z.array(z.string()),
});
export type CompositionOutput = z.infer<typeof CompositionOutputSchema>;

/** Output schema for applying an answer to one part of the CV. */
export const sectionOutputSchemas = {
  contact: z.object({ value: LlmContactSchema }),
  summary: z.object({ value: z.string() }),
  skills: z.object({ value: z.array(z.string()) }),
  experience: z.object({ value: z.array(LlmExperienceSchema) }),
  education: z.object({ value: z.array(LlmEducationSchema) }),
  experienceEntry: z.object({ value: LlmExperienceSchema }),
  educationEntry: z.object({ value: LlmEducationSchema }),
} as const;
export type SectionKind = keyof typeof sectionOutputSchemas;
