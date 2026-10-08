import type { Fact } from '@cv/shared';
import { vi, type Mock } from 'vitest';
import type { ApplyAnswerInput, CvLlm } from '../ai/cv-llm.js';
import type { CompositionOutput, ExtractionOutput, SectionKind } from '../ai/llm-schemas.js';

/** Test-only fixtures. Excluded from the production build (tsconfig.build.json). */

export const SOURCE_TEXT = `Jane Doe
jane.doe@example.com | +44 7700 900123 | London, UK

Backend Engineer at Acme Corp, Jan 2020 - Present
- Built a payments API in Node.js handling 1,200 requests per second
- Led a team of 4 engineers

Junior Developer at Globex, 2018 - 2019
- Maintained internal tools

BSc Computer Science, University of Leeds, 2015 - 2018

Skills: TypeScript, PostgreSQL, Kubernetes`;

export const TARGET_ROLE = 'Senior Backend Engineer';

const fact = (f: Omit<Fact, 'origin'>): Fact => ({ ...f, origin: 'source' });

export const FACTS: Fact[] = [
  fact({ id: 'f1', category: 'contact', entry: null, text: 'Name: Jane Doe', sourceQuote: 'Jane Doe' }),
  fact({
    id: 'f2',
    category: 'contact',
    entry: null,
    text: 'Email: jane.doe@example.com',
    sourceQuote: 'jane.doe@example.com',
  }),
  fact({ id: 'f3', category: 'contact', entry: null, text: 'Phone: +44 7700 900123', sourceQuote: '+44 7700 900123' }),
  fact({ id: 'f4', category: 'contact', entry: null, text: 'Based in London, UK', sourceQuote: 'London, UK' }),
  fact({
    id: 'f5',
    category: 'experience',
    entry: 'exp_1',
    text: 'Backend Engineer at Acme Corp since Jan 2020',
    sourceQuote: 'Backend Engineer at Acme Corp, Jan 2020 - Present',
  }),
  fact({
    id: 'f6',
    category: 'experience',
    entry: 'exp_1',
    text: 'Built a payments API in Node.js handling 1,200 requests per second',
    sourceQuote: 'Built a payments API in Node.js handling 1,200 requests per second',
  }),
  fact({
    id: 'f7',
    category: 'experience',
    entry: 'exp_1',
    text: 'Led a team of 4 engineers',
    sourceQuote: 'Led a team of 4 engineers',
  }),
  fact({
    id: 'f8',
    category: 'experience',
    entry: 'exp_2',
    text: 'Junior Developer at Globex from 2018 to 2019',
    sourceQuote: 'Junior Developer at Globex, 2018 - 2019',
  }),
  fact({
    id: 'f9',
    category: 'experience',
    entry: 'exp_2',
    text: 'Maintained internal tools',
    sourceQuote: 'Maintained internal tools',
  }),
  fact({
    id: 'f10',
    category: 'education',
    entry: 'edu_1',
    text: 'BSc Computer Science at University of Leeds, 2015 - 2018',
    sourceQuote: 'BSc Computer Science, University of Leeds, 2015 - 2018',
  }),
  fact({
    id: 'f11',
    category: 'skill',
    entry: null,
    text: 'Skills: TypeScript, PostgreSQL, Kubernetes',
    sourceQuote: 'Skills: TypeScript, PostgreSQL, Kubernetes',
  }),
];

export function extraction(overrides: Partial<ExtractionOutput> = {}): ExtractionOutput {
  return {
    facts: FACTS.map(({ origin: _origin, ...f }) => f),
    gaps: [{ fieldPath: 'experience:exp_2', question: 'What did you achieve at Globex?' }],
    ...overrides,
  };
}

/** A composition that is fully grounded in FACTS: verification should keep all of it. */
export function composition(): CompositionOutput {
  return {
    contact: {
      fullName: 'Jane Doe',
      email: 'jane.doe@example.com',
      phone: '+44 7700 900123',
      location: 'London, UK',
      links: [],
    },
    summary: 'Backend engineer focused on payments APIs in Node.js. Led a team of 4 engineers.',
    experience: [
      {
        id: 'exp_1',
        title: 'Backend Engineer',
        company: 'Acme Corp',
        location: '',
        startDate: 'Jan 2020',
        endDate: 'Present',
        bullets: [
          { text: 'Built a Node.js payments API serving 1,200 requests per second', factIds: ['f6'] },
          { text: 'Led a team of 4 engineers', factIds: ['f7'] },
        ],
      },
      {
        id: 'exp_2',
        title: 'Junior Developer',
        company: 'Globex',
        location: '',
        startDate: '2018',
        endDate: '2019',
        bullets: [{ text: 'Maintained internal tools', factIds: ['f9'] }],
      },
    ],
    education: [
      {
        id: 'edu_1',
        institution: 'University of Leeds',
        degree: 'BSc',
        field: 'Computer Science',
        startDate: '2015',
        endDate: '2018',
        details: '',
      },
    ],
    skills: ['TypeScript', 'PostgreSQL', 'Kubernetes'],
  };
}

/** A CvLlm whose methods are vi.fn()s, defaulting to the grounded fixtures above. */
export function fakeLlm() {
  const llm = {
    extractFacts: vi.fn<CvLlm['extractFacts']>(),
    composeCv: vi.fn<CvLlm['composeCv']>(),
    // Loosely typed so tests can return any section's value.
    applyAnswer: vi.fn<(input: ApplyAnswerInput<SectionKind>) => Promise<any>>(),
  } satisfies CvLlm;
  return resetFakeLlm(llm);
}
export type FakeLlm = ReturnType<typeof fakeLlm>;

/** Restores the default behaviour and clears recorded calls. */
export function resetFakeLlm<T extends Pick<FakeLlmMocks, keyof FakeLlmMocks>>(llm: T): T {
  llm.extractFacts.mockReset().mockImplementation(async () => extraction());
  llm.composeCv.mockReset().mockImplementation(async () => composition());
  llm.applyAnswer.mockReset().mockImplementation(async () => {
    throw new Error('applyAnswer not stubbed');
  });
  return llm;
}
interface FakeLlmMocks {
  extractFacts: Mock<CvLlm['extractFacts']>;
  composeCv: Mock<CvLlm['composeCv']>;
  applyAnswer: Mock<(input: ApplyAnswerInput<SectionKind>) => Promise<any>>;
}
