// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from '@playwright/test';

// The desktop app against a stand-in chat server and Cenacle ID (e2e/fake-server.ts).
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  reporter: process.env.CI
    ? [['list'], ['junit', { outputFile: 'test-results/junit.xml' }]]
    : 'list',
  use: { trace: 'retain-on-failure' },
});
