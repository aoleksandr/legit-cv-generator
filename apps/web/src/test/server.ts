import type { CvDetail, CvSummary, User } from '@cv/shared';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { PASSWORD, USER } from './fixtures';

/**
 * An in-memory stand-in for the API, so tests exercise the real app against
 * realistic responses (sessions, versions, 409s). Tests seed `db`, override
 * single endpoints with `server.use(...)`, and read `requests` to check payloads.
 */
export const db = {
  session: null as User | null,
  cvs: new Map<string, CvDetail>(),
};

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}
export const requests: RecordedRequest[] = [];

export function resetDb() {
  db.session = null;
  db.cvs.clear();
  requests.length = 0;
}

export function seedCv(cv: CvDetail) {
  db.cvs.set(cv.id, structuredClone(cv));
}

/** Requests the app sent, optionally filtered by "METHOD /path". */
export function sent(route?: string): RecordedRequest[] {
  return route ? requests.filter((r) => `${r.method} ${r.path}` === route) : requests;
}

const error = (status: number, message: string) => HttpResponse.json({ statusCode: status, message }, { status });
const summary = ({ id, title, targetRole, status, createdAt, updatedAt }: CvDetail): CvSummary => ({
  id,
  title,
  targetRole,
  status,
  createdAt,
  updatedAt,
});

function getCv(id: string) {
  return db.cvs.get(id);
}

let nextId = 1;

export const handlers = [
  http.post('/api/auth/login', async ({ request }) => {
    const { email, password } = (await request.json()) as { email: string; password: string };
    if (email !== USER.email || password !== PASSWORD) return error(401, 'Invalid email or password');
    db.session = USER;
    return HttpResponse.json(USER);
  }),
  http.post('/api/auth/signup', async ({ request }) => {
    const { email } = (await request.json()) as { email: string };
    if (email === USER.email) return error(409, 'An account with this email already exists');
    db.session = { id: 'u2', email };
    return HttpResponse.json(db.session, { status: 201 });
  }),
  http.post('/api/auth/logout', () => {
    db.session = null;
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/auth/me', () => (db.session ? HttpResponse.json(db.session) : error(401, 'Not signed in'))),

  http.get('/api/cvs', () => HttpResponse.json([...db.cvs.values()].map(summary))),
  http.post('/api/cvs', async ({ request }) => {
    const body = (await request.json()) as { targetRole: string };
    const created = newCv(body.targetRole, 'text');
    return HttpResponse.json(created, { status: 201 });
  }),
  http.post('/api/cvs/upload', async ({ request }) => {
    const form = await request.formData();
    const created = newCv(String(form.get('targetRole')), 'pdf');
    return HttpResponse.json(created, { status: 201 });
  }),
  http.get('/api/cvs/:id', ({ params }) => {
    const cv = getCv(params.id as string);
    return cv ? HttpResponse.json(cv) : error(404, 'CV not found');
  }),
  http.patch('/api/cvs/:id', async ({ params, request }) => {
    const cv = getCv(params.id as string);
    if (!cv) return error(404, 'CV not found');
    cv.title = ((await request.json()) as { title: string }).title;
    return HttpResponse.json(summary(cv));
  }),
  http.put('/api/cvs/:id/content', async ({ params, request }) => {
    const cv = getCv(params.id as string);
    if (!cv) return error(404, 'CV not found');
    const { version, content } = (await request.json()) as Pick<CvDetail, 'version' | 'content'>;
    if (version !== cv.version) return error(409, 'This CV was changed elsewhere. Reload to get the latest version.');
    Object.assign(cv, { content, version: cv.version + 1 });
    return HttpResponse.json(cv);
  }),
  http.post('/api/cvs/:id/retry', ({ params }) => {
    const cv = getCv(params.id as string);
    if (!cv) return error(404, 'CV not found');
    Object.assign(cv, { status: 'queued', error: null, progressStep: null });
    return HttpResponse.json(cv);
  }),
  http.delete('/api/cvs/:id', ({ params }) =>
    db.cvs.delete(params.id as string) ? new HttpResponse(null, { status: 204 }) : error(404, 'CV not found'),
  ),
  http.post('/api/cvs/:id/questions/:qid/answer', async ({ params, request }) => {
    const q = getCv(params.id as string)?.questions.find((x) => x.id === params.qid);
    if (!q) return error(404, 'Question not found');
    Object.assign(q, { answer: ((await request.json()) as { answer: string }).answer, applying: true, error: null });
    return HttpResponse.json(q);
  }),
  http.post('/api/cvs/:id/questions/:qid/dismiss', ({ params }) => {
    const q = getCv(params.id as string)?.questions.find((x) => x.id === params.qid);
    if (!q) return error(404, 'Question not found');
    q.status = 'dismissed';
    return HttpResponse.json(q);
  }),
];

function newCv(targetRole: string, sourceType: 'pdf' | 'text'): CvDetail {
  const now = new Date().toISOString();
  const cv: CvDetail = {
    id: `new${nextId++}`,
    title: `${targetRole} CV`,
    targetRole,
    status: 'queued',
    sourceType,
    progressStep: null,
    error: null,
    content: null,
    version: 0,
    questions: [],
    createdAt: now,
    updatedAt: now,
  };
  db.cvs.set(cv.id, cv);
  return cv;
}

export const server = setupServer(...handlers);

// Record every request the app makes (body parsed when it is JSON).
server.events.on('request:start', async ({ request }) => {
  const url = new URL(request.url);
  let body: unknown = null;
  if (request.headers.get('content-type')?.includes('application/json')) {
    body = await request
      .clone()
      .json()
      .catch(() => null);
  }
  requests.push({ method: request.method, path: url.pathname, body });
});
