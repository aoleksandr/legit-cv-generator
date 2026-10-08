import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { CreateCvFromText, CvDetail, CvDocument, CvSummary, Question } from '@cv/shared';
import { toast } from 'sonner';
import { api, ApiError } from './api';
import { errorMessage } from './components/ErrorBanner';

/**
 * Every server interaction goes through TanStack Query. Mutations are
 * optimistic: the cache is updated immediately, and on failure it is restored
 * from a snapshot and the user gets a toast explaining what was undone.
 */

export const keys = {
  cvs: ['cvs'] as const,
  cv: (id: string) => ['cv', id] as const,
};

const isBusy = (cv: CvDetail) =>
  cv.status === 'queued' || cv.status === 'processing' || cv.questions.some((q) => q.applying);

export function toastError(err: unknown, prefix: string) {
  toast.error(prefix, { description: errorMessage(err) });
}

/** Snapshot a query, apply an optimistic change, and return a rollback. */
async function optimistic<T>(qc: QueryClient, key: readonly unknown[], change: (old: T) => T) {
  await qc.cancelQueries({ queryKey: key });
  const previous = qc.getQueryData<T>(key);
  if (previous !== undefined) qc.setQueryData<T>(key, change(previous));
  return () => qc.setQueryData(key, previous);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useCvList() {
  return useQuery({
    queryKey: keys.cvs,
    queryFn: api.listCvs,
    // Keep statuses fresh while anything is still generating.
    refetchInterval: (q) => (q.state.data?.some((c) => c.status === 'queued' || c.status === 'processing') ? 3000 : false),
  });
}

export function useCv(id: string) {
  return useQuery({
    queryKey: keys.cv(id),
    queryFn: () => api.getCv(id),
    // All progress lives on the server; polling makes reloads and other devices just work.
    refetchInterval: (q) => (q.state.data && isBusy(q.state.data) ? 2000 : false),
  });
}

// ---------------------------------------------------------------------------
// CV mutations
// ---------------------------------------------------------------------------

export function useCreateCv() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { source: 'pdf'; file: File; targetRole: string } | ({ source: 'text' } & CreateCvFromText)) =>
      input.source === 'pdf' ? api.createFromPdf(input.file, input.targetRole) : api.createFromText(input),
    onSuccess: (cv) => {
      qc.setQueryData(keys.cv(cv.id), cv);
      void qc.invalidateQueries({ queryKey: keys.cvs });
    },
  });
}

export function useRenameCv(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (title: string) => api.renameCv(id, title),
    onMutate: async (title) => {
      const rollbackCv = await optimistic<CvDetail>(qc, keys.cv(id), (cv) => ({ ...cv, title }));
      const rollbackList = await optimistic<CvSummary[]>(qc, keys.cvs, (list) => list.map((c) => (c.id === id ? { ...c, title } : c)));
      return () => {
        rollbackCv();
        rollbackList();
      };
    },
    onError: (err, _title, rollback) => {
      rollback?.();
      toastError(err, 'Could not rename the CV');
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.cvs }),
  });
}

export function useDeleteCv(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.deleteCv(id),
    onMutate: () => optimistic<CvSummary[]>(qc, keys.cvs, (list) => list.filter((c) => c.id !== id)),
    onError: (err, _v, rollback) => {
      rollback?.();
      toastError(err, 'Could not delete the CV');
    },
    onSuccess: () => qc.removeQueries({ queryKey: keys.cv(id) }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.cvs }),
  });
}

export function useRetryCv(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.retryCv(id),
    onMutate: () =>
      optimistic<CvDetail>(qc, keys.cv(id), (cv) => ({ ...cv, status: 'queued', error: null, progressStep: null })),
    onError: (err, _v, rollback) => {
      rollback?.();
      toastError(err, 'Could not restart generation');
    },
    onSuccess: (cv) => qc.setQueryData(keys.cv(id), cv),
  });
}

/**
 * Saves the whole document with optimistic locking. The caller has already
 * shown the edit; on failure the cache (and therefore the editor) goes back to
 * the last version the server accepted.
 */
export function useSaveContent(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['save-content', id],
    mutationFn: ({ version, content }: { version: number; content: CvDocument }) => api.updateContent(id, version, content),
    onMutate: ({ content }) => optimistic<CvDetail>(qc, keys.cv(id), (cv) => ({ ...cv, content })),
    onError: async (err, _v, rollback) => {
      rollback?.();
      if (err instanceof ApiError && err.status === 409) {
        // Someone else (another device, or an answer being applied) changed the CV: take theirs.
        await qc.invalidateQueries({ queryKey: keys.cv(id) });
        toast.error('Your last edit was not saved', {
          description: 'This CV was changed elsewhere, so we loaded the latest version.',
        });
      } else {
        toastError(err, 'Your last edit was not saved');
      }
    },
    onSuccess: (cv) => qc.setQueryData(keys.cv(id), cv),
  });
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

function patchQuestion(cv: CvDetail, questionId: string, patch: Partial<Question>): CvDetail {
  return { ...cv, questions: cv.questions.map((q) => (q.id === questionId ? { ...q, ...patch } : q)) };
}

export function useAnswerQuestion(cvId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ questionId, answer }: { questionId: string; answer: string }) => api.answer(cvId, questionId, answer),
    onMutate: ({ questionId, answer }) =>
      optimistic<CvDetail>(qc, keys.cv(cvId), (cv) => patchQuestion(cv, questionId, { answer, applying: true, error: null })),
    onError: (err, _v, rollback) => {
      rollback?.();
      toastError(err, 'Could not send your answer');
    },
    onSuccess: (q) => qc.setQueryData<CvDetail>(keys.cv(cvId), (cv) => (cv ? patchQuestion(cv, q.id, q) : cv)),
  });
}

export function useDismissQuestion(cvId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (questionId: string) => api.dismiss(cvId, questionId),
    onMutate: (questionId) => optimistic<CvDetail>(qc, keys.cv(cvId), (cv) => patchQuestion(cv, questionId, { status: 'dismissed' })),
    onError: (err, _v, rollback) => {
      rollback?.();
      toastError(err, 'Could not skip the question');
    },
  });
}
