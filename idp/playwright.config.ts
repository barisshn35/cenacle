// SPDX-License-Identifier: Apache-2.0
import { defineConfig, devices } from '@playwright/test';

// The specs start Cenacle ID in-process (e2e/harness.ts) against the
// integration test database, so they run one at a time.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'fine', use: { ...devices['Desktop Chrome'] } },
    { name: 'coarse', use: { ...devices['Pixel 7'] } },
  ],
});
