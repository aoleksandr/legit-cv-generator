import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

/**
 * Signing in or out starts from an empty cache. Clearing only on logout isn't enough:
 * after a session expires, the next person to sign in in that tab would briefly see
 * the previous user's cached CVs.
 */
export function useSetUser() {
  const qc = useQueryClient();
  return (user: User | null) => {
    qc.clear();
    qc.setQueryData(meKey, user);
  };
}

/** Route guard: renders children only for a signed-in user. */
export function RequireAuth() {
  const { data: user, isPending, isError, refetch } = useMe();
  const location = useLocation();
  if (isPending) return null;
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

export function useLogout() {
  const setUser = useSetUser();
  return useMutation({
    mutationFn: api.logout,
    // Sign out locally even if the request fails: the cookie expires on its own.
    onSettled: () => setUser(null),
  });
}
