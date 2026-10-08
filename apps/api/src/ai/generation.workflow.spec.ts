import { composition, extraction, FACTS, fakeLlm, SOURCE_TEXT, TARGET_ROLE } from '../testing/fixtures.js';
import { LlmError } from './cv-llm.js';
import { MAX_QUESTIONS, runGeneration, toCvDocument } from './generation.workflow.js';

const input = { sourceText: SOURCE_TEXT, targetRole: TARGET_ROLE };

describe('runGeneration (Mastra workflow, mocked LLM)', () => {
  it('extracts, verifies, composes and checks, reporting each step', async () => {
    const llm = fakeLlm();
    const steps: string[] = [];
    const result = await runGeneration(llm, input, async (s) => void steps.push(s));

    expect(steps).toEqual(['extracting', 'verifying', 'writing', 'checking']);
    expect(result.content).toEqual(toCvDocument(composition()));
    expect(result.facts).toEqual(FACTS);
    expect(result.questions).toEqual([{ fieldPath: 'experience:exp_2', question: 'What did you achieve at Globex?' }]);
  });

  it('gives the composer only verified facts, never the raw source', async () => {
    const llm = fakeLlm();
    const invented = {
      id: 'f99',
      category: 'experience' as const,
      entry: 'exp_1',
      text: 'Won an award',
      sourceQuote: 'Won an award',
    };
    llm.extractFacts.mockResolvedValue(extraction({ facts: [...extraction().facts, invented] }));

    const result = await runGeneration(llm, input);

    const composerInput = llm.composeCv.mock.calls[0][0];
    expect(Object.keys(composerInput).sort()).toEqual(['facts', 'targetRole']);
    expect(composerInput.facts.map((f) => f.id)).not.toContain('f99');
    expect(result.removed).toContainEqual(expect.stringMatching(/fact f99 \(quote not found in source\)/));
  });

  it('strips unsupported content from the composed CV and turns it into questions', async () => {
    const llm = fakeLlm();
    const draft = composition();
    draft.experience[0].company = 'Initech';
    draft.experience[0].bullets.push({ text: 'Cut costs by 30%', factIds: [] });
    llm.composeCv.mockResolvedValue(draft);

    const result = await runGeneration(llm, input);

    expect(result.content.experience[0].company).toBe('');
    expect(result.content.experience[0].bullets).toHaveLength(2);
    expect(result.questions.map((q) => q.fieldPath)).toContain('experience:exp_1');
  });

  it('normalises gap field paths and caps the number of questions', async () => {
    const llm = fakeLlm();
    llm.extractFacts.mockResolvedValue(
      extraction({
        gaps: [
          { fieldPath: 'experience:exp_9', question: 'About a job that is not in the CV?' },
          { fieldPath: 'hobbies', question: 'Invalid path, dropped' },
          ...Array.from({ length: 20 }, (_, i) => ({
            fieldPath: i % 2 ? 'summary' : `education:edu_1`,
            question: `Q${i}`,
          })),
          ...Array.from({ length: 20 }, (_, i) => ({
            fieldPath: ['contact', 'skills', 'experience:exp_1', 'experience:exp_2', 'education'][i % 5],
            question: `R${i}`,
          })),
        ],
      }),
    );

    const { questions } = await runGeneration(llm, input);

    expect(questions[0]).toEqual({ fieldPath: 'experience', question: 'About a job that is not in the CV?' });
    expect(questions.map((q) => q.question)).not.toContain('Invalid path, dropped');
    expect(questions.length).toBe(MAX_QUESTIONS);
    // At most two questions per field path.
    const perPath = new Map<string, number>();
    for (const q of questions) perPath.set(q.fieldPath, (perPath.get(q.fieldPath) ?? 0) + 1);
    expect(Math.max(...perPath.values())).toBeLessThanOrEqual(2);
  });

  it('fails without retry when nothing in the source can be verified', async () => {
    const llm = fakeLlm();
    llm.extractFacts.mockResolvedValue(
      extraction({ facts: [{ ...extraction().facts[0], sourceQuote: 'not in the source' }] }),
    );

    const err = await runGeneration(llm, input).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ retryable: false, message: expect.stringMatching(/couldn't find any CV information/) });
    expect(llm.composeCv).not.toHaveBeenCalled();
  });

  it('rethrows the original LlmError from a step, keeping its retryable flag', async () => {
    const llm = fakeLlm();
    const original = new LlmError('The AI service is temporarily unavailable.', true);
    llm.composeCv.mockRejectedValue(original);

    await expect(runGeneration(llm, input)).rejects.toBe(original);
  });

  it('wraps unexpected errors as retryable without leaking their details', async () => {
    const llm = fakeLlm();
    llm.extractFacts.mockRejectedValue(new TypeError('cannot read properties of undefined'));

    const err = await runGeneration(llm, input).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ retryable: true, message: 'Generation failed.' });
  });

  it('drops extracted facts that fail schema validation', async () => {
    const llm = fakeLlm();
    const facts = extraction().facts;
    llm.extractFacts.mockResolvedValue(
      extraction({ facts: [...facts, { ...facts[0], id: 'bad', category: 'nonsense' as never }] }),
    );

    const result = await runGeneration(llm, input);
    expect(result.facts.map((f) => f.id)).not.toContain('bad');
  });
});

describe('toCvDocument (untrusted composer output)', () => {
  it('clamps oversized fields, fixes bad ids and drops empty bullets', () => {
    const draft = composition();
    draft.summary = 'x'.repeat(5000);
    draft.experience[0].id = 'not a valid id!';
    draft.experience[1].id = 'not a valid id!';
    draft.experience[0].bullets.push({ text: '   ', factIds: ['f1'] });
    draft.skills = Array.from({ length: 500 }, (_, i) => `skill ${i}`);

    const doc = toCvDocument(draft);

    expect(doc.summary).toHaveLength(2000);
    expect(doc.experience.map((e) => e.id)).toEqual(['exp_1', 'exp_2']);
    expect(doc.experience[0].bullets).toHaveLength(2);
    expect(doc.skills).toHaveLength(100);
  });

  it('tolerates missing sections', () => {
    const doc = toCvDocument({ contact: undefined, summary: undefined } as never);
    expect(doc).toMatchObject({ summary: '', experience: [], education: [], skills: [] });
  });
});
