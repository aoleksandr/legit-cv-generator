import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { User } from '@cv/shared';
import { Navigate, Outlet, useLocation } from 'react-router';
import { api, ApiError } from './api';

export const meKey = ['me'] as const;

export function useMe() {
  return useQuery<User | null>({
    queryKey: meKey,
    queryFn: async () => {
      try {
        return await api.me();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: Infinity,
    retry: false,
  });
}

export function useSetUser() {
  const qc = useQueryClient();
  return (user: User | null) => {
    if (!user) qc.clear();
    qc.setQueryData(meKey, user);
  };
}

/** Route guard: renders children only for a signed-in user. */
export function RequireAuth() {
  const { data: user, isPending, isError, refetch } = useMe();
  const location = useLocation();
  if (isPending) return <FullPageSpinner />;
  if (isError) {
    return (
      <div className="p-8 text-center">
        <p className="mb-4 text-slate-600">Cannot reach the server.</p>
        <button className="btn-secondary" onClick={() => refetch()}>
          Try again
        </button>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

export function FullPageSpinner() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-200 border-t-indigo-600" />
    </div>
  );
}
