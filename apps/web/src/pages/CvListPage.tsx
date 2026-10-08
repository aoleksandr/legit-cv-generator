import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../api';
import { FullPageSpinner } from '../auth';
import { ErrorBanner } from '../components/ErrorBanner';
import { StatusBadge } from '../components/StatusBadge';

export function CvListPage() {
  const { data: cvs, isPending, error } = useQuery({
    queryKey: ['cvs'],
    queryFn: api.listCvs,
    // Keep statuses fresh while anything is still generating.
    refetchInterval: (q) => (q.state.data?.some((c) => c.status === 'queued' || c.status === 'processing') ? 3000 : false),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Your CVs</h1>
        <Link to="/cvs/new" className="btn-primary">
          New CV
        </Link>
      </div>
      {error && <ErrorBanner error={error} />}
      {isPending ? (
        <FullPageSpinner />
      ) : cvs && cvs.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="mb-4 text-slate-600">You don't have any CVs yet.</p>
          <Link to="/cvs/new" className="btn-primary">
            Create your first CV
          </Link>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cvs?.map((cv) => (
            <li key={cv.id}>
              <Link to={`/cvs/${cv.id}`} className="card block p-4 transition hover:border-indigo-300 hover:shadow">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <h2 className="min-w-0 font-medium break-words">{cv.title}</h2>
                  <StatusBadge status={cv.status} />
                </div>
                <p className="text-sm text-slate-500">{cv.targetRole}</p>
                <p className="mt-2 text-xs text-slate-400">Updated {new Date(cv.updatedAt).toLocaleString()}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
