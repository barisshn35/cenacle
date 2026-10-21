#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Generates TypeScript types from the chat server's OpenAPI spec.
// The output is formatted with the repository's Prettier settings, so that
// regenerating an unchanged spec leaves no diff.

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const spec = resolve(here, '../../../server/api/openapi.yaml');
const out = resolve(here, '../src/api/schema.ts');

if (!existsSync(spec)) {
  console.error(`gen:api: no OpenAPI spec at ${spec}`);
  process.exit(1);
}

execFileSync('openapi-typescript', [spec, '--output', out], { stdio: 'inherit' });
execFileSync('prettier', ['--write', '--log-level', 'warn', out], { stdio: 'inherit' });
