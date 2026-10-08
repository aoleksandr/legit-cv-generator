import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Opt-in eval against the real Anthropic API (`pnpm eval`). Kept out of
 * vitest.config.ts, whose env deliberately replaces the API key with a fake one.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['eval/**/*.eval.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 10 * 60_000,
    // Cases run concurrently; keep it modest to stay clear of rate limits.
    maxConcurrency: 3,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
