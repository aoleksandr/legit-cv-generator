import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { File as NodeFile } from 'node:buffer';
import { resetDb, server } from './server';

// jsdom swaps in its own File and FormData, but fetch is still Node's, which rejects them.
// Browsers have one consistent set; give the tests Node's (FormData taken from a Response,
// since jsdom does not replace Response).
const NodeFormData = (await new Response(new URLSearchParams()).formData()).constructor as typeof FormData;
Object.assign(globalThis, { File: NodeFile, FormData: NodeFormData });

// Any request without a handler is a bug in the test or the app.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetDb();
  vi.restoreAllMocks();
});
afterAll(() => server.close());
