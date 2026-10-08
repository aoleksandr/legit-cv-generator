import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { App, createQueryClient, routes } from '../app';

/** Renders the whole app (real routes, guards, query client and toasts) at `path`. */
export function renderApp(path = '/', userOptions?: Parameters<typeof userEvent.setup>[0]) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const user = userEvent.setup(userOptions);
  render(<App router={router} queryClient={createQueryClient()} />);
  return { user, router };
}
