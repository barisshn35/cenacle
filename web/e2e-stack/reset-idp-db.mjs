// SPDX-License-Identifier: AGPL-3.0-only
//
// Empties the Cenacle ID database. The IdP's own end-to-end tests share it
// with their own key encryption key; without this, the IdP of the stack tests
// could not decrypt the stored signing keys and TOTP secrets. Accounts start
// fresh too (the tests create them), so two-step verification starts off. The
// sign-in policy makes it optional here: the tests that need it turn it on (the
// required setup during sign-in is covered by Cenacle ID's own tests). Directory
// and identity-provider sources go too: other tests may leave ones it cannot use.
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../idp/package.json', import.meta.url));
const pg = require('pg');

const client = new pg.Client({ connectionString: process.env.IDP_DATABASE_URL });
await client.connect();
await client.query(
  'TRUNCATE signing_keys, oidc_payloads, users, audit_events, identity_sources, deleted_accounts CASCADE',
);
await client.query('UPDATE sign_in_policy SET require_two_step = false');
await client.end();
