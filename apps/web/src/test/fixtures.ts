import type { CvDetail, CvDocument, Question, User } from '@cv/shared';

export const USER: User = { id: 'u1', email: 'jane@example.com' };
export const PASSWORD = 'correct horse battery';

export function content(overrides: Partial<CvDocument> = {}): CvDocument {
  return {
    contact: { fullName: 'Jane Doe', email: 'jane@example.com', phone: '', location: 'London', links: [] },
    summary: 'Backend engineer focused on payments APIs.',
    experience: [
      {
        id: 'exp_1',
        title: 'Backend Engineer',
        company: 'Acme Corp',
        location: '',
        startDate: '2020',
        endDate: 'Present',
        bullets: [{ id: 'b1', text: 'Built a payments API', factIds: ['f1'] }],
      },
    ],
    education: [],
    skills: ['TypeScript', 'PostgreSQL'],
    ...overrides,
  };
}

export function question(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q1',
    fieldPath: 'experience:exp_1',
    question: 'What did you achieve at Acme Corp?',
    answer: null,
    status: 'open',
    applying: false,
    error: null,
    ...overrides,
  };
}

export function cv(overrides: Partial<CvDetail> = {}): CvDetail {
  return {
    id: 'cv1',
    title: 'Backend CV',
    targetRole: 'Senior Backend Engineer',
    status: 'ready',
    sourceType: 'text',
    progressStep: null,
    error: null,
    content: content(),
    version: 1,
    questions: [question()],
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}
