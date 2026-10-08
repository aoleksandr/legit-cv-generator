import type { CvDocument } from '@cv/shared';
import { composition, FACTS, fakeLlm, TARGET_ROLE } from '../testing/fixtures.js';
import { applyAnswer, splicePart } from './apply-answer.js';
import { toCvDocument } from './generation.workflow.js';

const QUESTION_ID = '0b7c2f4e-1d7a-4c39-9b2e-3a1f5d6e7c8b';
const ANSWER_FACT_ID = 'answer_0b7c2f4e1d7a';

function baseContent(): CvDocument {
  return toCvDocument(composition());
}

describe('applyAnswer', () => {
  it('rewrites only the targeted entry and records the answer as a fact', async () => {
    const llm = fakeLlm();
    const content = baseContent();
    llm.applyAnswer.mockImplementation(async () => ({
      ...composition().experience[1],
      bullets: [
        { text: 'Maintained internal tools', factIds: ['f9'] },
        { text: 'Automated 3 release pipelines', factIds: [ANSWER_FACT_ID] },
      ],
    }));

    const result = await applyAnswer(llm, {
      content,
      facts: FACTS,
      questionId: QUESTION_ID,
      fieldPath: 'experience:exp_2',
      question: 'What did you achieve at Globex?',
      answer: 'I automated 3 release pipelines.',
      targetRole: TARGET_ROLE,
    });

    expect(llm.applyAnswer.mock.calls[0][0]).toMatchObject({ kind: 'experienceEntry', answerFactId: ANSWER_FACT_ID });
    expect(result.content.experience[1].bullets.map((b) => b.text)).toContain('Automated 3 release pipelines');
    expect(result.content.experience[0]).toEqual(content.experience[0]);
    expect({ ...result.content, experience: [] }).toEqual({ ...content, experience: [] });
    expect(result.facts.at(-1)).toMatchObject({ id: ANSWER_FACT_ID, origin: 'user_answer', entry: 'exp_2' });
  });

  it('runs the rewritten part through the same grounding checks', async () => {
    const llm = fakeLlm();
    llm.applyAnswer.mockImplementation(async () => ({
      ...composition().experience[1],
      company: 'Globex International',
      bullets: [{ text: 'Automated 30 release pipelines', factIds: [ANSWER_FACT_ID] }],
    }));

    const result = await applyAnswer(llm, {
      content: baseContent(),
      facts: FACTS,
      questionId: QUESTION_ID,
      fieldPath: 'experience:exp_2',
      question: 'What did you achieve at Globex?',
      answer: 'I automated 3 release pipelines.',
      targetRole: TARGET_ROLE,
    });

    expect(result.content.experience[1].company).toBe('');
    expect(result.content.experience[1].bullets).toEqual([]);
    expect(result.removed.join('\n')).toMatch(/numbers 30/);
  });

  it('does not re-check (and strip) manual edits outside the targeted part', async () => {
    const llm = fakeLlm();
    const content = baseContent();
    // A user edit that is not backed by any fact. It is the user's own content, so it must survive.
    content.experience[0].bullets.push({ id: 'manual', text: 'Cut AWS costs by 25%', factIds: [] });
    llm.applyAnswer.mockImplementation(async () => ['TypeScript', 'PostgreSQL', 'Kubernetes', 'Terraform']);

    const result = await applyAnswer(llm, {
      content,
      facts: FACTS,
      questionId: QUESTION_ID,
      fieldPath: 'skills',
      question: 'Any infrastructure tools?',
      answer: 'Terraform',
      targetRole: TARGET_ROLE,
    });

    expect(result.content.skills).toEqual(['TypeScript', 'PostgreSQL', 'Kubernetes', 'Terraform']);
    expect(result.content.experience[0].bullets.at(-1)?.text).toBe('Cut AWS costs by 25%');
  });

  it('falls back to the whole section when the entry was deleted', async () => {
    const llm = fakeLlm();
    llm.applyAnswer.mockImplementation(async () => composition().education);

    await applyAnswer(llm, {
      content: baseContent(),
      facts: FACTS,
      questionId: QUESTION_ID,
      fieldPath: 'education:edu_9',
      question: 'Where did you study?',
      answer: 'University of Leeds',
      targetRole: TARGET_ROLE,
    });

    expect(llm.applyAnswer.mock.calls[0][0].kind).toBe('education');
  });

  it('rejects an unknown field path without calling the model', async () => {
    const llm = fakeLlm();
    await expect(
      applyAnswer(llm, {
        content: baseContent(),
        facts: FACTS,
        questionId: QUESTION_ID,
        fieldPath: 'hobbies',
        question: '?',
        answer: '!',
        targetRole: TARGET_ROLE,
      }),
    ).rejects.toMatchObject({ retryable: false });
    expect(llm.applyAnswer).not.toHaveBeenCalled();
  });
});

describe('splicePart', () => {
  it('copies only the addressed part into newer content', () => {
    const newer = baseContent();
    newer.summary = 'Edited by the user meanwhile';
    const answered = baseContent();
    answered.experience[1].title = 'Developer';
    answered.summary = 'Stale summary';

    const merged = splicePart(newer, answered, 'experience:exp_2');

    expect(merged.experience[1].title).toBe('Developer');
    expect(merged.summary).toBe('Edited by the user meanwhile');
  });

  it('leaves content untouched when the entry no longer exists in the answer', () => {
    const newer = baseContent();
    const answered = baseContent();
    answered.experience = [];
    expect(splicePart(newer, answered, 'experience:exp_2')).toEqual(newer);
  });
});
