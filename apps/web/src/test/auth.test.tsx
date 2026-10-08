import { screen, waitFor } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { cv, PASSWORD, USER } from './fixtures';
import { renderApp } from './render';
import { db, seedCv, sent, server } from './server';

describe('signing in', () => {
  it('sends a signed-out visitor to the login page, then back to where they were going', async () => {
    seedCv(cv());
    const { user, router } = renderApp('/cvs/cv1');

    await user.type(await screen.findByLabelText('Email'), USER.email);
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: /Backend CV/ })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/cvs/cv1');
  });

  it('shows the server’s error for wrong credentials', async () => {
    const { user } = renderApp('/login');

    await user.type(await screen.findByLabelText('Email'), USER.email);
    await user.type(screen.getByLabelText('Password'), 'wrong password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
  });

  it('validates the form before calling the server', async () => {
    const { user } = renderApp('/login');

    await user.type(await screen.findByLabelText('Email'), 'not-an-email');
    await user.type(screen.getByLabelText('Password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid email address.');
    expect(sent('POST /api/auth/login')).toEqual([]);
  });

  it('offers the dev test account in dev mode', async () => {
    const { user } = renderApp('/login');

    await user.click(await screen.findByRole('button', { name: 'Use test account' }));

    expect(screen.getByLabelText('Email')).toHaveValue('test@example.com');
    expect(screen.getByLabelText('Password')).toHaveValue('password123');
  });

  it('signs up and lands on the empty CV list', async () => {
    const { user } = renderApp('/signup');

    await user.type(await screen.findByLabelText('Email'), 'new@example.com');
    await user.type(screen.getByLabelText('Password'), 'long enough password');
    await user.click(screen.getByRole('button', { name: 'Sign up' }));

    expect(await screen.findByText("You don't have any CVs yet.")).toBeInTheDocument();
    expect(sent('POST /api/auth/signup')[0].body).toEqual({
      email: 'new@example.com',
      password: 'long enough password',
    });
  });
});

describe('a signed-in session', () => {
  beforeEach(() => {
    db.session = USER;
  });

  it('lists the user’s CVs with their status', async () => {
    seedCv(cv());
    seedCv(cv({ id: 'cv2', title: 'Data CV', status: 'failed' }));
    renderApp('/');

    expect(await screen.findByRole('link', { name: /Backend CV.*Ready/ })).toHaveAttribute('href', '/cvs/cv1');
    expect(screen.getByRole('link', { name: /Data CV.*Failed/ })).toHaveAttribute('href', '/cvs/cv2');
  });

  it('logs out', async () => {
    const { user, router } = renderApp('/');

    await user.click(await screen.findByRole('button', { name: 'Log out' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(db.session).toBeNull();
  });

  it('returns to the login page when the session expires mid-use', async () => {
    seedCv(cv());
    const { router } = renderApp('/');
    await screen.findByRole('link', { name: /Backend CV/ });

    // The cookie expired: the next request is rejected.
    server.use(
      http.get('/api/cvs/:id', () =>
        HttpResponse.json({ statusCode: 401, message: 'Session expired' }, { status: 401 }),
      ),
    );
    await router.navigate('/cvs/cv1');

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });

  it('never shows the previous user’s data to the next person who signs in', async () => {
    seedCv(cv());
    const { user, router } = renderApp('/');
    await screen.findByRole('link', { name: /Backend CV/ });

    // Jane's session expires while the list is cached.
    server.use(
      http.get('/api/cvs', () => HttpResponse.json({ statusCode: 401, message: 'Session expired' }, { status: 401 }), {
        once: true,
      }),
    );
    await router.navigate('/cvs/new');
    await screen.findByRole('heading', { name: 'New CV' });
    await router.navigate('/');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));

    // Someone else signs up in the same tab; their (empty) list is slow to load.
    db.cvs.clear();
    server.use(http.get('/api/cvs', () => delay(200)));
    await user.click(screen.getByRole('link', { name: 'Sign up' }));
    await user.type(await screen.findByLabelText('Email'), 'bob@example.com');
    await user.type(screen.getByLabelText('Password'), 'long enough password');
    await user.click(screen.getByRole('button', { name: 'Sign up' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(screen.queryByText('Backend CV')).not.toBeInTheDocument();
    expect(await screen.findByText("You don't have any CVs yet.")).toBeInTheDocument();
  });
});
