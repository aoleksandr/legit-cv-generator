import { emptyCvDocument, LIMITS, type CvDetail } from '@cv/shared';
import { PdfService } from '../src/pdf/pdf.service.js';
import { SOURCE_TEXT, TARGET_ROLE } from '../src/testing/fixtures.js';
import { createCv, createReadyCv, createTestApp, jobsFor, signUp, type Agent, type TestContext } from './helpers.js';

describe('CVs (e2e)', () => {
  let ctx: TestContext;
  let alice: Agent;
  let mallory: Agent;
  beforeAll(async () => {
    ctx = await createTestApp();
    alice = await signUp(ctx.app);
    mallory = await signUp(ctx.app);
  });
  afterAll(() => ctx.app.close());

  describe('creation and generation', () => {
    it('creates a queued CV and enqueues its job in the same request', async () => {
      const cv = await createCv(alice);

      expect(cv).toMatchObject({ status: 'queued', targetRole: TARGET_ROLE, content: null, version: 0 });
      expect(await jobsFor(ctx.prisma, cv.id)).toEqual([{ name: 'generate-cv', state: 'created' }]);
    });

    it('stores only the source text and validates its length', async () => {
      await alice.post('/api/cvs').send({ targetRole: TARGET_ROLE, text: 'too short' }).expect(400);
      await alice.post('/api/cvs').send({ targetRole: 'x', text: SOURCE_TEXT }).expect(400);
      await alice
        .post('/api/cvs')
        .send({ targetRole: TARGET_ROLE, text: 'x'.repeat(LIMITS.sourceTextMaxChars + 1) })
        .expect(400);
    });

    it('generates content and questions that the user can then load', async () => {
      const cv = await createReadyCv(ctx, alice);

      expect(cv.status).toBe('ready');
      expect(cv.version).toBe(1);
      expect(cv.content?.contact.fullName).toBe('Jane Doe');
      expect(cv.questions).toEqual([
        expect.objectContaining({ fieldPath: 'experience:exp_2', status: 'open', applying: false }),
      ]);
      // The fact ledger is internal and never sent to the client.
      expect(cv).not.toHaveProperty('facts');
      expect(cv).not.toHaveProperty('sourceText');
    });

    it('lists only the user’s own CVs', async () => {
      const list = (await alice.get('/api/cvs').expect(200)).body as { id: string }[];
      expect(list.length).toBeGreaterThan(0);
      expect((await mallory.get('/api/cvs').expect(200)).body).toEqual([]);
    });
  });

  describe('ownership isolation', () => {
    let cv: CvDetail;
    beforeAll(async () => {
      cv = await createReadyCv(ctx, alice);
    });

    it('returns 404 (not 403) for every route on another user’s CV', async () => {
      const q = cv.questions[0].id;
      await mallory.get(`/api/cvs/${cv.id}`).expect(404);
      await mallory.get(`/api/cvs/${cv.id}/pdf`).expect(404);
      await mallory.patch(`/api/cvs/${cv.id}`).send({ title: 'mine now' }).expect(404);
      await mallory.put(`/api/cvs/${cv.id}/content`).send({ version: cv.version, content: cv.content }).expect(404);
      await mallory.post(`/api/cvs/${cv.id}/retry`).expect(404);
      await mallory.post(`/api/cvs/${cv.id}/questions/${q}/answer`).send({ answer: 'hi' }).expect(404);
      await mallory.post(`/api/cvs/${cv.id}/questions/${q}/dismiss`).expect(404);
      await mallory.delete(`/api/cvs/${cv.id}`).expect(404);

      // Nothing changed for the owner.
      const after = (await alice.get(`/api/cvs/${cv.id}`).expect(200)).body as CvDetail;
      expect(after).toMatchObject({ title: cv.title, version: cv.version, content: cv.content });
      expect(after.questions[0]).toMatchObject({ status: 'open', answer: null });
    });

    it('returns 404 for a question that belongs to a different CV', async () => {
      const other = await createReadyCv(ctx, mallory);
      await mallory.post(`/api/cvs/${other.id}/questions/${cv.questions[0].id}/dismiss`).expect(404);
    });

    it('rejects malformed ids', async () => {
      await alice.get('/api/cvs/not-a-uuid').expect(400);
    });
  });

  describe('manual editing', () => {
    it('saves a valid edit and bumps the version', async () => {
      const cv = await createReadyCv(ctx, alice);
      const content = { ...cv.content!, summary: 'Edited by hand' };

      const res = await alice.put(`/api/cvs/${cv.id}/content`).send({ version: cv.version, content }).expect(200);

      expect(res.body).toMatchObject({ version: cv.version + 1, content: { summary: 'Edited by hand' } });
    });

    it('returns 409 for a stale version and keeps the newer content', async () => {
      const cv = await createReadyCv(ctx, alice);
      const first = { ...cv.content!, summary: 'From tab A' };
      const second = { ...cv.content!, summary: 'From tab B' };

      await alice.put(`/api/cvs/${cv.id}/content`).send({ version: cv.version, content: first }).expect(200);
      await alice.put(`/api/cvs/${cv.id}/content`).send({ version: cv.version, content: second }).expect(409);

      expect((await alice.get(`/api/cvs/${cv.id}`)).body.content.summary).toBe('From tab A');
    });

    it('validates edits against the shared CvDocument schema', async () => {
      const cv = await createReadyCv(ctx, alice);
      const res = await alice
        .put(`/api/cvs/${cv.id}/content`)
        .send({ version: cv.version, content: { ...cv.content!, skills: ['x'.repeat(101)] } })
        .expect(400);
      expect(res.body.details[0].path).toBe('content.skills.0');
    });

    it('does not accept edits before generation has finished', async () => {
      const cv = await createCv(alice);
      await alice.put(`/api/cvs/${cv.id}/content`).send({ version: 0, content: emptyCvDocument() }).expect(409);
    });

    it('renames and deletes', async () => {
      const cv = await createCv(alice);
      expect((await alice.patch(`/api/cvs/${cv.id}`).send({ title: '  Backend v2 ' }).expect(200)).body.title).toBe(
        'Backend v2',
      );
      await alice.delete(`/api/cvs/${cv.id}`).expect(204);
      await alice.get(`/api/cvs/${cv.id}`).expect(404);
    });
  });

  describe('PDF download', () => {
    it('renders an A4 PDF from the saved content', async () => {
      const cv = await createReadyCv(ctx, alice);
      const res = await alice
        .get(`/api/cvs/${cv.id}/pdf`)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="Jane Doe - /);
      const pdf = res.body as Buffer;
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      // A4 in points.
      expect(pdf.toString('latin1')).toMatch(/\/MediaBox \[0 0 595\.2\d* 841\.8\d*\]/);
    });

    it('returns 409 while the CV is not ready', async () => {
      const cv = await createCv(alice);
      await alice.get(`/api/cvs/${cv.id}/pdf`).expect(409);
    });
  });

  describe('PDF upload validation', () => {
    const upload = (file: Buffer | null, role: string | null = TARGET_ROLE, name = 'cv.pdf') => {
      const req = alice.post('/api/cvs/upload');
      if (role !== null) req.field('targetRole', role);
      if (file) req.attach('file', file, { filename: name, contentType: 'application/pdf' });
      return req;
    };

    it('accepts a PDF with a text layer and stores its text', async () => {
      const pdf = await new PdfService().render({ ...emptyCvDocument(), summary: SOURCE_TEXT }, 'fixture');
      const res = await upload(pdf).expect(201);
      expect(res.body.sourceType).toBe('pdf');

      const row = await ctx.prisma.cv.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row.sourceText).toContain('Backend Engineer at Acme Corp');
    });

    it('checks magic bytes, not the declared content type', async () => {
      const res = await upload(Buffer.from('MZ\x90\x00 definitely an executable'), TARGET_ROLE, 'cv.pdf').expect(400);
      expect(res.body.message).toBe('The uploaded file is not a PDF');
    });

    it('rejects a PDF without extractable text with a clear message', async () => {
      const blank = await new PdfService().render(emptyCvDocument(), 'blank');
      const res = await upload(blank).expect(422);
      expect(res.body.message).toMatch(/no selectable text/);
    });

    it('rejects a corrupt PDF', async () => {
      await upload(Buffer.from('%PDF-1.7\nthis is not really a pdf')).expect(422);
    });

    it('rejects files over the size limit', async () => {
      const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(LIMITS.pdfMaxBytes)]);
      await upload(big).expect((res) => expect([400, 413]).toContain(res.status));
    });

    it('requires a file and a target role', async () => {
      await upload(null).expect(400);
      const pdf = await new PdfService().render({ ...emptyCvDocument(), summary: SOURCE_TEXT }, 'fixture');
      await upload(pdf, null).expect(400);
    });
  });
});
