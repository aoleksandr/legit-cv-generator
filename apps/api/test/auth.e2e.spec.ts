import request from 'supertest';
import { createTestApp, signUp, type TestContext } from './helpers.js';

describe('auth (e2e)', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.app.close());

  const http = () => request(ctx.app.getHttpServer());

  it('signs up with an httpOnly session cookie and no password hash in the response', async () => {
    const res = await http()
      .post('/api/auth/signup')
      .send({ email: '  Alice@Example.com ', password: 'correct horse battery' })
      .expect(201);

    expect(res.body).toEqual({ id: expect.any(String), email: 'alice@example.com' });
    const cookie = res.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toMatch(/^cv_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('rejects a duplicate email regardless of case', async () => {
    await http()
      .post('/api/auth/signup')
      .send({ email: 'ALICE@example.com', password: 'another password' })
      .expect(409);
  });

  it('validates the signup body', async () => {
    const res = await http().post('/api/auth/signup').send({ email: 'not-an-email', password: 'short' }).expect(400);
    expect(res.body.details.map((d: { path: string }) => d.path).sort()).toEqual(['email', 'password']);
  });

  it('logs in, and gives the same error for a wrong password and an unknown email', async () => {
    await http()
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'correct horse battery' })
      .expect(200);
    const wrong = await http()
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'wrong password' })
      .expect(401);
    const unknown = await http()
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong password' })
      .expect(401);
    expect(wrong.body.message).toBe(unknown.body.message);
  });

  it('requires a valid session for protected routes', async () => {
    await http().get('/api/cvs').expect(401);
    await http().get('/api/auth/me').set('Cookie', 'cv_session=forged.token.value').expect(401);
  });

  it('returns the current user and logs out', async () => {
    const agent = await signUp(ctx.app, 'bob@example.com');
    expect((await agent.get('/api/auth/me').expect(200)).body.email).toBe('bob@example.com');

    await agent.post('/api/auth/logout').expect(204);
    await agent.get('/api/auth/me').expect(401);
  });

  it('rate-limits login attempts', async () => {
    const throttled = await createTestApp({ throttle: true });
    try {
      const attempt = () =>
        request(throttled.app.getHttpServer())
          .post('/api/auth/login')
          .send({ email: 'alice@example.com', password: 'guess guess' });
      for (let i = 0; i < 10; i++) await attempt().expect(401);
      await attempt().expect(429);
    } finally {
      await throttled.app.close();
    }
  });

  it('serves the public health check', async () => {
    expect((await http().get('/api/health').expect(200)).body.ok).toBe(true);
  });
});
