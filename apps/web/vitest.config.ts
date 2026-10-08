import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.tsx'],
    // Polling (2 s) and autosave (800 ms) run on real timers, as in the browser.
    testTimeout: 15_000,
  },
});
