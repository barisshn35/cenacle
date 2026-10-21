// SPDX-License-Identifier: Apache-2.0
//
// Empties the chat test database before the stack tests (after migrations,
// before the server starts and recreates the default channels): Cenacle ID's
// test database is reset too, so accounts from earlier runs would linger as
// duplicates.
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../idp/package.json', import.meta.url));
const pg = require('pg');

const client = new pg.Client({ connectionString: process.env.CENACLE_DATABASE_URL });
await client.connect();
await client.query('TRUNCATE users, channels CASCADE');
await client.end();
