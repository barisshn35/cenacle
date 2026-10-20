#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Generates TypeScript types from the chat server's OpenAPI spec.
// Until the spec exists (v0.3) this is a no-op with an explanation, so that
// `make gen` works on every checkout.

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const spec = resolve(here, '../../../server/api/openapi.yaml');
const out = resolve(here, '../src/api/schema.ts');

if (!existsSync(spec)) {
  console.log(`gen:api: no OpenAPI spec at ${spec} yet (added in v0.3); keeping the placeholder.`);
  process.exit(0);
}

execFileSync('openapi-typescript', [spec, '--output', out], { stdio: 'inherit' });
