import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  plugins: [react()],
  // base is /zencode/ so that when the built SPA is served by the backend
  // at /zencode, all asset references are correctly prefixed.
  base: '/zencode/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      // Forward auth, API, and gateway calls to the Bun backend during dev.
      '/auth': { target: 'http://localhost:8787', changeOrigin: true },
      '/user-api': { target: 'http://localhost:8787', changeOrigin: true },
      '/v1': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
});

