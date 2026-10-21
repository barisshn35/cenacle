// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const port = Number(process.env.WEB_PORT ?? 15173);
// The chat server, reached through this dev server so the app, its API and
// the session cookie share one origin (as behind the production proxy).
const api = process.env.CENACLE_DEV_API ?? 'http://127.0.0.1:8180';
const proxy = { '/api': { target: api }, '/ws': { target: api, ws: true } };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    proxy,
  },
  preview: {
    host: '127.0.0.1',
    port: port + 1,
    strictPort: true,
    proxy,
  },
  build: {
    target: 'es2023',
    sourcemap: true,
    // Everything, fonts included, is served from our own origin.
    assetsInlineLimit: 0,
    rolldownOptions: {
      output: {
        // Third-party code changes less often than ours: separate cache entry.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'tanstack', test: /node_modules[\\/]@tanstack[\\/]/ },
            { name: 'vendor', test: /node_modules/ },
          ],
        },
      },
    },
  },
});
