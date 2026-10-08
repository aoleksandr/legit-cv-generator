import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Same-origin /api in dev, exactly like nginx does in docker: the session cookie just works.
    proxy: { '/api': 'http://localhost:3000' },
  },
});
