import type {
  Credentials,
  CreateCvFromText,
  CvDetail,
  CvDocument,
  CvSummary,
  Question,
  User,
} from '@cv/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      ...init,
      headers: init.body instanceof FormData ? init.headers : { 'content-type': 'application/json', ...init.headers },
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // Gateway errors (or a non-JSON error page) mean the API itself is down or unreachable.
    const unreachable = [502, 503, 504].includes(res.status) || typeof body?.message !== 'string';
    const message = unreachable
      ? res.status >= 500
        ? 'Cannot reach the server. Please try again in a moment.'
        : `Request failed (${res.status})`
      : body.message;
    throw new ApiError(res.status, message, body?.details);
  }
  return body as T;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  me: () => request<User>('/auth/me'),
  login: (c: Credentials) => request<User>('/auth/login', json('POST', c)),
  signup: (c: Credentials) => request<User>('/auth/signup', json('POST', c)),
  logout: () => request<void>('/auth/logout', json('POST')),

  listCvs: () => request<CvSummary[]>('/cvs'),
  getCv: (id: string) => request<CvDetail>(`/cvs/${id}`),
  createFromText: (body: CreateCvFromText) => request<CvDetail>('/cvs', json('POST', body)),
  createFromPdf: (file: File, targetRole: string) => {
    const form = new FormData();
    form.append('targetRole', targetRole);
    form.append('file', file);
    return request<CvDetail>('/cvs/upload', { method: 'POST', body: form });
  },
  renameCv: (id: string, title: string) => request<CvSummary>(`/cvs/${id}`, json('PATCH', { title })),
  updateContent: (id: string, version: number, content: CvDocument) =>
    request<CvDetail>(`/cvs/${id}/content`, json('PUT', { version, content })),
  retryCv: (id: string) => request<CvDetail>(`/cvs/${id}/retry`, json('POST')),
  deleteCv: (id: string) => request<void>(`/cvs/${id}`, json('DELETE')),
  answer: (cvId: string, questionId: string, answer: string) =>
    request<Question>(`/cvs/${cvId}/questions/${questionId}/answer`, json('POST', { answer })),
  dismiss: (cvId: string, questionId: string) =>
    request<Question>(`/cvs/${cvId}/questions/${questionId}/dismiss`, json('POST')),
  pdfUrl: (id: string) => `/api/cvs/${id}/pdf`,
};
