// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.WEB_PORT ?? 15173);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  // A cold start of the app on a loaded runner can take more than the default
  // 5 s before the first assertion holds.
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    // Mouse/trackpad: targets >= 24 px (WCAG 2.5.8), project goal 28 px.
    { name: 'fine', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
    // Touch: pointer is coarse, targets >= 44 px.
    { name: 'coarse', use: { ...devices['Pixel 7'] } },
    // The other engines (E2E_BROWSERS=all; release tags): the same journeys
    // with a mouse in Firefox and in WebKit (Safari).
    ...(process.env.E2E_BROWSERS === 'all'
      ? [
          {
            name: 'firefox',
            use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 900 } },
          },
          {
            name: 'webkit',
            use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 900 } },
          },
        ]
      : []),
  ],
  webServer: {
    // The component gallery only exists in the dev server.
    // Node 26's V8 aborts on a lazy deopt after a fast API call (nodejs/node#66870); the flag
    // is refused in NODE_OPTIONS, so Vite starts through node.
    command: `node --no-turbo-fast-api-calls node_modules/vite/bin/vite.js --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
