// SPDX-License-Identifier: Apache-2.0
//
// Empties the Cenacle ID database. The IdP's own end-to-end tests share it
// with their own key encryption key; without this, the IdP of the stack tests
// could not decrypt the stored signing keys and TOTP secrets. Accounts start
// fresh too (the tests create them), so two-step verification starts off.
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../idp/package.json', import.meta.url));
const pg = require('pg');

const client = new pg.Client({ connectionString: process.env.IDP_DATABASE_URL });
await client.connect();
await client.query('TRUNCATE signing_keys, oidc_payloads, users, audit_events CASCADE');
await client.end();
