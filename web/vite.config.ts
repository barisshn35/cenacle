// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { noticesFor, packageDirOf } from '../scripts/third-party-notices.mjs';

const port = Number(process.env.WEB_PORT ?? 15173);
// The chat server, reached through this dev server so the app, its API and
// the session cookie share one origin (as behind the production proxy).
const api = process.env.CENACLE_DEV_API ?? 'http://127.0.0.1:8180';
// Uploads go straight to the object store (the production proxy does the same).
const s3 = process.env.CENACLE_DEV_S3 ?? 'http://127.0.0.1:13900';
const proxy = {
  '/api': { target: api },
  '/ws': { target: api, ws: true },
  '/cenacle-files': { target: s3 },
};

/**
 * Serves the emoji picker's data (emojibase, MIT) from our own origin under
 * /emoji/en/, in development and in the build: no CDN.
 */
function emojiData(): Plugin {
  const require = createRequire(import.meta.url);
  const files = ['data.json', 'messages.json'];
  const read = (file: string) => readFileSync(require.resolve(`emojibase-data/en/${file}`));
  return {
    name: 'cenacle-emoji-data',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = files.find((f) => req.url === `/emoji/en/${f}`);
        if (!file) return next();
        res.setHeader('Content-Type', 'application/json');
        res.end(read(file));
      });
    },
    generateBundle() {
      for (const file of files) {
        this.emitFile({ type: 'asset', fileName: `emoji/en/${file}`, source: read(file) });
      }
    },
  };
}

/**
 * Writes /third-party-notices.txt in the build: the licenses of every package
 * the bundle contains (code, styles, fonts and the emoji data).
 */
function thirdPartyNotices(): Plugin {
  const require = createRequire(import.meta.url);
  return {
    name: 'cenacle-third-party-notices',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = [...this.getModuleIds()];
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'asset') files.push(...chunk.originalFileNames);
      }
      files.push(require.resolve('emojibase-data/en/data.json'));
      const dirs = new Set(
        files
          .map((f) => f.replace(/^\0/, '').split('?')[0]!)
          .filter((f) => f.includes('node_modules'))
          .map((f) => packageDirOf(f))
          .filter((d): d is string => d !== null),
      );
      this.emitFile({
        type: 'asset',
        fileName: 'third-party-notices.txt',
        source: noticesFor(dirs, 'Third-party notices of the Cenacle web app'),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), emojiData(), thirdPartyNotices()],
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
        // The framework changes less often than ours: separate cache entries.
        // Other libraries stay with the code that imports them, so what loads
        // later (code highlighting, the emoji picker, admin pages) is not part
        // of the first download.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'tanstack', test: /node_modules[\\/]@tanstack[\\/]/ },
          ],
        },
      },
    },
  },
});
