import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CvDetail } from '@cv/shared';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError } from '../api';
import { FullPageSpinner } from '../auth';
import { ErrorBanner } from '../components/ErrorBanner';
import { GenerationProgress } from '../components/GenerationProgress';
import { QuestionsPanel } from '../components/QuestionsPanel';
import { StatusBadge } from '../components/StatusBadge';
import { CvEditor } from '../editor/CvEditor';
import { useCvDraft, type SaveState } from '../editor/useCvDraft';

const isBusy = (cv: CvDetail) =>
  cv.status === 'queued' || cv.status === 'processing' || cv.questions.some((q) => q.applying);

export function CvPage() {
  const { id } = useParams<{ id: string }>();
  const { data: cv, error, isPending } = useQuery({
    queryKey: ['cv', id],
    queryFn: () => api.getCv(id!),
    // All progress lives on the server; polling makes reloads and other devices just work.
    refetchInterval: (q) => (q.state.data && isBusy(q.state.data) ? 2000 : false),
  });

  if (isPending) return <FullPageSpinner />;
  if (error) {
    const notFound = error instanceof ApiError && (error.status === 404 || error.status === 400);
    return (
      <div className="mx-auto max-w-xl space-y-4 text-center">
        <ErrorBanner>{notFound ? 'This CV does not exist or you do not have access to it.' : (error as Error).message}</ErrorBanner>
        <Link to="/" className="btn-secondary">
          Back to your CVs
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <CvHeader cv={cv} />
      {cv.status === 'queued' || cv.status === 'processing' ? (
        <GenerationProgress cv={cv} />
      ) : cv.status === 'failed' ? (
        <FailedView cv={cv} />
      ) : cv.content ? (
        <ReadyView key={cv.id} cv={cv} />
      ) : (
        <ErrorBanner>This CV's content could not be loaded.</ErrorBanner>
      )}
    </div>
  );
}

function CvHeader({ cv }: { cv: CvDetail }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(cv.title);

  const rename = useMutation({
    mutationFn: (t: string) => api.renameCv(cv.id, t),
    onSuccess: (s) => {
      qc.setQueryData<CvDetail>(['cv', cv.id], (old) => (old ? { ...old, title: s.title } : old));
      void qc.invalidateQueries({ queryKey: ['cvs'] });
      setEditing(false);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteCv(cv.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cvs'] });
      navigate('/');
    },
  });

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <Link to="/" className="text-sm text-slate-500 hover:text-slate-800">
          ← All CVs
        </Link>
        {editing ? (
          <form
            className="mt-1 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (title.trim()) rename.mutate(title.trim());
            }}
          >
            <input className="input" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} autoFocus />
            <button className="btn-primary" disabled={rename.isPending}>
              Save
            </button>
            <button type="button" className="btn-ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <h1 className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-semibold break-words">
            {cv.title}
            <button
              className="btn-ghost text-sm font-normal"
              onClick={() => {
                setTitle(cv.title);
                setEditing(true);
              }}
            >
              Rename
            </button>
          </h1>
        )}
        <p className="mt-1 flex items-center gap-2 text-sm text-slate-500">
          Target role: {cv.targetRole} <StatusBadge status={cv.status} />
        </p>
        <ErrorBanner error={rename.error ?? remove.error} />
      </div>
      <button
        className="btn-ghost self-start text-red-600 hover:bg-red-50 hover:text-red-700"
        onClick={() => confirm('Delete this CV? This cannot be undone.') && remove.mutate()}
        disabled={remove.isPending}
      >
        Delete
      </button>
    </div>
  );
}

function FailedView({ cv }: { cv: CvDetail }) {
  const qc = useQueryClient();
  const retry = useMutation({
    mutationFn: () => api.retryCv(cv.id),
    onSuccess: (updated) => qc.setQueryData(['cv', cv.id], updated),
  });
  return (
    <div className="card mx-auto max-w-xl space-y-4 p-6">
      <h2 className="font-semibold">We couldn't generate this CV</h2>
      <ErrorBanner>{cv.error ?? 'Something went wrong.'}</ErrorBanner>
      <ErrorBanner error={retry.error} />
      <div className="flex gap-2">
        <button className="btn-primary" onClick={() => retry.mutate()} disabled={retry.isPending}>
          Try again
        </button>
        <Link to="/cvs/new" className="btn-secondary">
          Start over
        </Link>
      </div>
    </div>
  );
}

function ReadyView({ cv }: { cv: CvDetail }) {
  const { draft, update, saveState, saveError, retrySave, reloadLatest } = useCvDraft(cv);
  const unsaved = saveState === 'pending' || saveState === 'saving';

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-4">
        <div className="sticky top-14 z-[5] -mx-4 flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50/95 px-4 py-2 backdrop-blur lg:mx-0 lg:rounded-lg lg:border">
          <SaveIndicator state={saveState} />
          <a
            href={api.pdfUrl(cv.id)}
            className={`btn-primary ${unsaved || saveState === 'conflict' ? 'pointer-events-none opacity-50' : ''}`}
            aria-disabled={unsaved || saveState === 'conflict'}
            download
          >
            Download PDF
          </a>
        </div>
        {saveState === 'conflict' && (
          <ErrorBanner>
            <p className="mb-2">
              This CV was changed elsewhere (another tab or device, or an answered question). Your latest edits were not saved.
            </p>
            <button className="btn-secondary" onClick={() => void reloadLatest()}>
              Load the latest version
            </button>
          </ErrorBanner>
        )}
        {saveState === 'error' && (
          <ErrorBanner>
            <p className="mb-2">Your changes could not be saved: {saveError}</p>
            <button className="btn-secondary" onClick={retrySave}>
              Retry
            </button>
          </ErrorBanner>
        )}
        <CvEditor draft={draft} update={update} />
      </div>
      <div className="order-first lg:sticky lg:top-20 lg:order-last">
        <QuestionsPanel cv={cv} disabledReason={unsaved ? 'Saving your edits…' : saveState === 'conflict' ? 'Load the latest version first.' : undefined} />
      </div>
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  const text: Record<SaveState, string> = {
    idle: 'All changes saved',
    pending: 'Unsaved changes…',
    saving: 'Saving…',
    saved: 'All changes saved',
    error: 'Not saved',
    conflict: 'Not saved: conflict',
  };
  const color = state === 'error' || state === 'conflict' ? 'text-red-600' : 'text-slate-500';
  return <span className={`text-sm ${color}`}>{text[state]}</span>;
}
