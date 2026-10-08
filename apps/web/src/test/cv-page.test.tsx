import { screen, waitFor, within } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { content, cv, question, USER } from './fixtures';
import { renderApp } from './render';
import { db, seedCv, sent, server } from './server';

const summaryBox = () => screen.getByPlaceholderText('A short summary targeting the role');

beforeEach(() => {
  db.session = USER;
});

describe('generation', () => {
  it('shows progress and switches to the editor when the CV is ready', async () => {
    seedCv(cv({ status: 'processing', progressStep: 'writing', content: null, questions: [] }));
    renderApp('/cvs/cv1');

    expect(await screen.findByRole('heading', { name: 'Generating your CV…' })).toBeInTheDocument();

    // The worker finishes; the page polls and picks it up without a reload.
    Object.assign(db.cvs.get('cv1')!, { status: 'ready', progressStep: null, content: content() });

    expect(await screen.findByDisplayValue('Jane Doe', {}, { timeout: 4000 })).toBeInTheDocument();
  });

  it('offers a retry after a failure', async () => {
    seedCv(cv({ status: 'failed', error: 'The AI service is temporarily unavailable.', content: null }));
    const { user } = renderApp('/cvs/cv1');

    expect(await screen.findByRole('alert')).toHaveTextContent('The AI service is temporarily unavailable.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('heading', { name: 'Waiting to start…' })).toBeInTheDocument();
    expect(sent('POST /api/cvs/cv1/retry')).toHaveLength(1);
  });

  it('says so when the CV does not exist or belongs to someone else', async () => {
    renderApp('/cvs/someone-elses');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This CV does not exist or you do not have access to it.',
    );
  });
});

describe('editing', () => {
  it('autosaves edits with the current version', async () => {
    seedCv(cv());
    const { user } = renderApp('/cvs/cv1');

    await user.clear(await screen.findByDisplayValue('Backend engineer focused on payments APIs.'));
    await user.type(summaryBox(), 'Payments engineer.');

    expect(screen.getByText('Saving your edits…')).toBeInTheDocument();
    expect(await screen.findByText('All changes saved')).toBeInTheDocument();
    // Debounced: one save for the whole burst of typing.
    const saves = sent('PUT /api/cvs/cv1/content');
    expect(saves).toHaveLength(1);
    expect(saves[0].body).toMatchObject({ version: 1, content: { summary: 'Payments engineer.' } });
    expect(db.cvs.get('cv1')!.version).toBe(2);
  });

  it('saves an edit made just before leaving the page', async () => {
    seedCv(cv());
    const { user } = renderApp('/cvs/cv1');
    await user.type(await screen.findByDisplayValue('Backend engineer focused on payments APIs.'), ' Leaving now.');

    // Within the autosave delay, go back to the list.
    await user.click(screen.getByRole('link', { name: '← All CVs' }));

    expect(await screen.findByRole('heading', { name: 'Your CVs' })).toBeInTheDocument();
    await waitFor(() => expect(sent('PUT /api/cvs/cv1/content')).toHaveLength(1));
    await waitFor(() =>
      expect(db.cvs.get('cv1')!.content!.summary).toBe('Backend engineer focused on payments APIs. Leaving now.'),
    );
  });

  it('saves edits made while a save was in flight, after leaving the page', async () => {
    seedCv(cv());
    // Slow saves; returning nothing falls through to the regular handler.
    server.use(http.put('/api/cvs/:id/content', () => delay(300)));
    const { user } = renderApp('/cvs/cv1');
    await user.type(await screen.findByDisplayValue('Backend engineer focused on payments APIs.'), ' One.');
    await waitFor(() => expect(sent('PUT /api/cvs/cv1/content')).toHaveLength(1));

    await user.type(summaryBox(), ' Two.');
    await user.click(screen.getByRole('link', { name: '← All CVs' }));

    // The second save waits for the first, then carries the version it produced.
    await waitFor(() => expect(sent('PUT /api/cvs/cv1/content')).toHaveLength(2), { timeout: 3000 });
    expect(sent('PUT /api/cvs/cv1/content')[1].body).toMatchObject({ version: 2 });
    await waitFor(() =>
      expect(db.cvs.get('cv1')!.content!.summary).toBe('Backend engineer focused on payments APIs. One. Two.'),
    );
  });

  it('on a conflict, drops the edit, loads the latest version and explains why', async () => {
    seedCv(cv());
    const { user } = renderApp('/cvs/cv1');
    await screen.findByDisplayValue('Jane Doe');

    // Meanwhile, the CV is changed on another device.
    Object.assign(db.cvs.get('cv1')!, { version: 2, content: content({ summary: 'Edited on my phone.' }) });
    await user.type(summaryBox(), ' Extra words.');

    expect(await screen.findByText('Your last edit was not saved')).toBeInTheDocument();
    expect(screen.getByText('This CV was changed elsewhere, so we loaded the latest version.')).toBeInTheDocument();
    await waitFor(() => expect(summaryBox()).toHaveValue('Edited on my phone.'));
  });

  it('renames optimistically and rolls back if the server refuses', async () => {
    seedCv(cv());
    server.use(
      http.patch('/api/cvs/:id', () =>
        HttpResponse.json({ statusCode: 500, message: 'Database is down' }, { status: 500 }),
      ),
    );
    const { user } = renderApp('/cvs/cv1');

    await user.click(await screen.findByRole('button', { name: 'Rename' }));
    const input = screen.getByDisplayValue('Backend CV');
    await user.clear(input);
    await user.type(input, 'Payments CV{Enter}');

    expect(await screen.findByText('Could not rename the CV')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Backend CV');
  });

  it('deletes after confirmation and returns to the list', async () => {
    seedCv(cv());
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { user, router } = renderApp('/cvs/cv1');

    await user.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(await screen.findByText("You don't have any CVs yet.")).toBeInTheDocument();
  });
});

describe('questions', () => {
  it('sends an answer, and shows the updated CV once the AI has applied it', async () => {
    seedCv(cv());
    const { user } = renderApp('/cvs/cv1');
    const panel = await screen.findByRole('complementary');

    await user.type(within(panel).getByPlaceholderText('Your answer'), 'Cut payment failures by 30%');
    await user.click(within(panel).getByRole('button', { name: 'Answer' }));

    expect(await within(panel).findByText(/Adding your answer to the CV/)).toBeInTheDocument();
    expect(sent('POST /api/cvs/cv1/questions/q1/answer')[0].body).toEqual({ answer: 'Cut payment failures by 30%' });

    // The background job applies it; polling brings the new content in.
    const stored = db.cvs.get('cv1')!;
    stored.content!.experience[0].bullets.push({ id: 'b2', text: 'Cut payment failures by 30%', factIds: ['a1'] });
    Object.assign(stored, {
      version: 2,
      questions: [question({ status: 'answered', answer: 'Cut payment failures by 30%' })],
    });

    expect(await screen.findByDisplayValue('Cut payment failures by 30%', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(within(panel).getByText('No open questions. You can still edit anything by hand.')).toBeInTheDocument();
  });

  it('tells the user when an answer could not be applied', async () => {
    seedCv(cv({ questions: [question({ applying: true, answer: 'Something' })] }));
    renderApp('/cvs/cv1');
    await screen.findByText(/Adding your answer to the CV/);

    Object.assign(db.cvs.get('cv1')!.questions[0], { applying: false, error: 'The AI took too long to respond.' });

    expect(await screen.findByText('Your answer could not be applied', {}, { timeout: 4000 })).toBeInTheDocument();
  });

  it('skips a question', async () => {
    seedCv(cv());
    const { user } = renderApp('/cvs/cv1');

    await user.click(await screen.findByRole('button', { name: 'Skip' }));

    expect(await screen.findByText('No open questions. You can still edit anything by hand.')).toBeInTheDocument();
    expect(sent('POST /api/cvs/cv1/questions/q1/dismiss')).toHaveLength(1);
  });
});
