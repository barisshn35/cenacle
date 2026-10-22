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
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    // Mouse/trackpad: targets >= 24 px (WCAG 2.5.8), project goal 28 px.
    { name: 'fine', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
    // Touch: pointer is coarse, targets >= 44 px.
    { name: 'coarse', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    // The component gallery only exists in the dev server.
    command: `pnpm exec vite --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
