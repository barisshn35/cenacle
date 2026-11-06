// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Integration tests share one database; run test files one after another.
    fileParallelism: false,
    // Empties the shared test database once every file has run.
    globalSetup: ['test/helpers/teardown.ts'],
  },
});
