// SPDX-License-Identifier: Apache-2.0
//
// Empties the Cenacle ID tables that depend on the key encryption key. The
// IdP's own end-to-end tests share this database with their own key; without
// this, the IdP of the stack tests could not decrypt the stored signing keys.
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../idp/package.json', import.meta.url));
const pg = require('pg');

const client = new pg.Client({ connectionString: process.env.IDP_DATABASE_URL });
await client.connect();
await client.query('TRUNCATE signing_keys, oidc_payloads');
await client.end();
