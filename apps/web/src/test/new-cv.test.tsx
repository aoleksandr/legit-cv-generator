import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { USER } from './fixtures';
import { renderApp } from './render';
import { db, sent, server } from './server';

const BACKGROUND =
  'Jane Doe, jane@example.com. Backend Engineer at Acme Corp since 2020, built a payments API in Node.js.';

describe('creating a CV', () => {
  beforeEach(() => {
    db.session = USER;
  });

  it('from text: sends it and shows generation progress', async () => {
    const { user, router } = renderApp('/cvs/new');

    await user.type(await screen.findByLabelText('Target role'), 'Senior Backend Engineer');
    await user.click(screen.getByRole('tab', { name: 'Describe yourself' }));
    await user.type(screen.getByLabelText('Your background'), BACKGROUND);
    await user.click(screen.getByRole('button', { name: 'Generate CV' }));

    expect(await screen.findByRole('heading', { name: 'Waiting to start…' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/cvs/new1');
    expect(sent('POST /api/cvs')[0].body).toEqual({ targetRole: 'Senior Backend Engineer', text: BACKGROUND });
  });

  it('from a PDF: uploads the file with the role', async () => {
    let uploaded: { role: FormDataEntryValue | null; file: File | null } | undefined;
    server.use(
      http.post('/api/cvs/upload', async ({ request }) => {
        const form = await request.formData();
        uploaded = { role: form.get('targetRole'), file: form.get('file') as File | null };
        return HttpResponse.json({ statusCode: 422, message: 'This PDF has no selectable text.' }, { status: 422 });
      }),
    );
    const { user } = renderApp('/cvs/new');

    await user.type(await screen.findByLabelText('Target role'), 'Product Designer');
    await user.upload(
      screen.getByLabelText(/Your current CV/),
      new File(['%PDF-1.7'], 'cv.pdf', { type: 'application/pdf' }),
    );
    await user.click(screen.getByRole('button', { name: 'Generate CV' }));

    // The server's explanation is shown as is.
    expect(await screen.findByRole('alert')).toHaveTextContent('This PDF has no selectable text.');
    expect(uploaded?.role).toBe('Product Designer');
    expect(uploaded?.file?.name).toBe('cv.pdf');
  });

  it('validates input before sending anything', async () => {
    // Users can bypass the input's `accept` filter ("All files" in the picker), so don't apply it.
    const { user } = renderApp('/cvs/new', { applyAccept: false });

    await user.click(await screen.findByRole('button', { name: 'Generate CV' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the role you are targeting');

    await user.type(screen.getByLabelText('Target role'), 'Backend Engineer');
    await user.click(screen.getByRole('button', { name: 'Generate CV' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a PDF file.');

    await user.upload(screen.getByLabelText(/Your current CV/), new File(['x'], 'notes.txt', { type: 'text/plain' }));
    await user.click(screen.getByRole('button', { name: 'Generate CV' }));
    expect(screen.getByRole('alert')).toHaveTextContent('The file must be a PDF.');

    await user.click(screen.getByRole('tab', { name: 'Describe yourself' }));
    await user.type(screen.getByLabelText('Your background'), 'Too short');
    await user.click(screen.getByRole('button', { name: 'Generate CV' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Tell us a bit more');

    expect(sent().filter((r) => r.method === 'POST')).toEqual([]);
  });

  it('explains when the server is unreachable', async () => {
    server.use(http.post('/api/cvs', () => HttpResponse.error()));
    const { user } = renderApp('/cvs/new');

    await user.type(await screen.findByLabelText('Target role'), 'Backend Engineer');
    await user.click(screen.getByRole('tab', { name: 'Describe yourself' }));
    await user.type(screen.getByLabelText('Your background'), BACKGROUND);
    await user.click(screen.getByRole('button', { name: 'Generate CV' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the server');
  });
});
