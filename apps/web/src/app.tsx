import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Navigate, RouterProvider, type createBrowserRouter, type RouteObject } from 'react-router';
import { Toaster } from 'sonner';
import { ApiError } from './api';
import { meKey, RequireAuth } from './auth';
import { Layout } from './components/Layout';
import { AuthPage } from './pages/AuthPage';
import { CvListPage } from './pages/CvListPage';
import { CvPage } from './pages/CvPage';
import { NewCvPage } from './pages/NewCvPage';

/** The app's routes; main.tsx mounts them in a browser router, tests in a memory router. */
export const routes: RouteObject[] = [
  { path: '/login', element: <AuthPage mode="login" /> },
  { path: '/signup', element: <AuthPage mode="signup" /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <Layout />,
        children: [
          { path: '/', element: <CvListPage /> },
          { path: '/cvs/new', element: <NewCvPage /> },
          { path: '/cvs/:id', element: <CvPage /> },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
];

export function createQueryClient(): QueryClient {
  // An expired session anywhere sends the user back to the login page.
  const onError = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) client.setQueryData(meKey, null);
  };
  const client = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
        refetchOnWindowFocus: true,
      },
    },
  });
  return client;
}

export function App({
  router,
  queryClient,
}: {
  router: ReturnType<typeof createBrowserRouter>;
  queryClient: QueryClient;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster position="top-center" richColors closeButton />
    </QueryClientProvider>
  );
}
