import type { CvDetail } from '@cv/shared';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { GenerationProgress } from '../components/GenerationProgress';
import { QuestionsPanel } from '../components/QuestionsPanel';
import { StatusBadge } from '../components/StatusBadge';
import { CvEditor } from '../editor/CvEditor';
import { useCvDraft } from '../editor/useCvDraft';
import { useCv, useDeleteCv, useRenameCv, useRetryCv } from '../queries';

export function CvPage() {
  const { id } = useParams<{ id: string }>();
  const { data: cv, error, isPending } = useCv(id!);

  if (isPending) return null;
  if (error) {
    const notFound = error instanceof ApiError && (error.status === 404 || error.status === 400);
    return (
      <div className="mx-auto max-w-xl space-y-4 text-center">
        <ErrorBanner>
          {notFound ? 'This CV does not exist or you do not have access to it.' : (error as Error).message}
        </ErrorBanner>
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
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(cv.title);
  const rename = useRenameCv(cv.id);
  const remove = useDeleteCv(cv.id);

  const submitRename = () => {
    const next = title.trim();
    if (next && next !== cv.title) rename.mutate(next);
    setEditing(false);
  };
  const deleteCv = () => {
    if (!confirm('Delete this CV? This cannot be undone.')) return;
    remove.mutate(undefined, { onError: () => navigate(`/cvs/${cv.id}`) });
    navigate('/');
  };

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
              submitRename();
            }}
          >
            <input
              className="input"
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
            <button className="btn-primary">Save</button>
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
      </div>
      <button className="btn-ghost self-start text-red-600 hover:bg-red-50 hover:text-red-700" onClick={deleteCv}>
        Delete
      </button>
    </div>
  );
}

function FailedView({ cv }: { cv: CvDetail }) {
  const retry = useRetryCv(cv.id);
  return (
    <div className="card mx-auto max-w-xl space-y-4 p-6">
      <h2 className="font-semibold">We couldn't generate this CV</h2>
      <ErrorBanner>{cv.error ?? 'Something went wrong.'}</ErrorBanner>
      <div className="flex gap-2">
        <button className="btn-primary" onClick={() => retry.mutate()}>
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
  const { draft, update, saving } = useCvDraft(cv);

  return (
    // grid-cols-1 (minmax(0, 1fr)) on phones: an implicit column sizes to its content's min-content width,
    // so one long unwrappable line (e.g. an entry heading) would make the whole page scroll sideways.
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-4">
        <div className="sticky top-14 z-[5] -mx-4 flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50/95 px-4 py-2 backdrop-blur lg:mx-0 lg:rounded-lg lg:border">
          <span className="text-sm text-slate-500" aria-live="polite">
            {saving ? 'Saving your edits…' : 'All changes saved'}
          </span>
          {/* The PDF is rendered from the saved CV, so wait until edits are saved. */}
          <a
            href={api.pdfUrl(cv.id)}
            className={`btn-primary ${saving ? 'pointer-events-none opacity-50' : ''}`}
            aria-disabled={saving}
            download
          >
            Download PDF
          </a>
        </div>
        <CvEditor draft={draft} update={update} />
      </div>
      {/* On wide screens the panel sticks beside the editor, capped so its questions scroll inside
          it. The cap must fit where it starts before the page scrolls (below the app header and
          the CV title, about 12rem down), or its end sits off-screen until the page scrolls. */}
      <div className="order-first lg:sticky lg:top-20 lg:order-last lg:flex lg:max-h-[calc(100dvh-14rem)] lg:flex-col">
        <QuestionsPanel cv={cv} />
      </div>
    </div>
  );
}
