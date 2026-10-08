import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx', 'test/**/*.spec.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // e2e specs share one database; run files sequentially.
    fileParallelism: false,
  },
  // SWC emits decorator metadata, which Nest's DI relies on (esbuild does not).
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
