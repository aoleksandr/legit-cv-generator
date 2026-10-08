import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** e2e specs use their own database, never the dev one. */
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://cv:cv@localhost:5432/cv_test';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    setupFiles: ['test/setup.ts'],
    env: {
      DATABASE_URL: testDatabaseUrl,
      // Tests never reach Anthropic: the LLM is replaced at the CvLlm / Mastra Agent boundary.
      ANTHROPIC_API_KEY: 'test-key-never-sent',
      JWT_SECRET: 'test-secret',
      // e2e specs drive jobs by calling the handlers directly.
      WORKER_ENABLED: 'false',
    },
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'] },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['test/**/*.spec.ts'],
          globalSetup: ['test/global-setup.ts'],
          // Specs share one database; run files sequentially.
          fileParallelism: false,
        },
      },
    ],
  },
  // SWC emits decorator metadata, which Nest's DI relies on (esbuild does not).
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
