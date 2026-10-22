// SPDX-License-Identifier: Apache-2.0
//
// Signing in with other identity providers: an OpenID Connect provider (a
// small oidc-provider with its development sign-in pages) and a SAML 2.0
// provider (a test server that signs assertions with xml-crypto).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import Provider from 'oidc-provider';
import * as client from 'openid-client';
import { SignedXml } from 'xml-crypto';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  DATABASE_URL,
  EMAIL,
  PASSWORD,
  startHarness,
  type Harness,
} from './harness.ts';

test.skip(!DATABASE_URL, 'IDP_TEST_DATABASE_URL is not set');
test.describe.configure({ mode: 'serial' });

let h: Harness;
const servers: Server[] = [];
let certDir = '';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, 'localhost', r));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

test.beforeAll(async () => {
  h = await startHarness({ loginRateLimit: 1000, directory: true });
});
test.afterAll(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  if (certDir) rmSync(certDir, { recursive: true, force: true });
  await h?.close();
});

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .options({
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      rules: { 'target-size': { enabled: true } },
    })
    .analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
}

/** Starts an app's sign-in at Cenacle ID; returns what the token request needs. */
async function startAuthorization(page: Page) {
  const config = await client.discovery(
    new URL(h.issuer),
    CLIENT_ID,
    undefined,
    client.ClientSecretBasic(CLIENT_SECRET),
    { execute: [client.allowInsecureRequests] },
  );
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: h.callbackUrl,
    scope: 'openid email profile',
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
  });
  await page.goto(url.href);
  return { config, verifier, state };
}

test('an administrator adds an identity provider', async ({ page }) => {
  await page.goto(`${h.issuer}/account`);
  await page.getByLabel('E-mail address').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'Administration' }).click();
  await page.getByRole('link', { name: 'Identity providers' }).click();
  await page.getByRole('link', { name: 'Add a SAML 2.0 provider' }).click();
  await page.getByLabel('Name on the sign-in button').fill('Corporate SSO');
  await page.getByRole('button', { name: 'Save' }).click();
  // Required settings are missing.
  await expect(page.getByRole('alert')).toContainText('entryPoint');
  await axe(page);

  await page.getByLabel('Single sign-on URL (HTTP-Redirect)').fill('https://sso.example.com/saml');
  await page.getByLabel('Identity provider entity id (issuer)').fill('https://sso.example.com');
  await page
    .getByLabel('Signing certificate(s) of the identity provider (PEM)')
    .fill('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----');
  await page.getByRole('checkbox', { name: 'On (shown on the sign-in pages)' }).uncheck();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  const register = page.getByTestId('register');
  await expect(register).toContainText(`${h.issuer}/federation/`);
  await expect(register).toContainText('/acs');
  await axe(page);
  // Off: not offered at sign-in.
  await page.goto(`${h.issuer}/account`);
  await expect(page.getByTestId('provider')).toHaveCount(0);
  await h.pool.query(`DELETE FROM identity_sources WHERE kind = 'saml'`);
});

test('signing in to an app with an OpenID Connect provider', async ({ page }) => {
  // The provider and its registration of Cenacle ID.
  const upstreamServer = createServer();
  const port = await listen(upstreamServer);
  const upstreamIssuer = `http://localhost:${port}`;
  const secret = 'upstream-client-secret-0123456789';
  const source = await h.providers.create({
    kind: 'oidc',
    name: 'Upstream',
    enabled: true,
    secret,
    config: {
      issuer: upstreamIssuer,
      clientId: 'cenacle-id',
      scopes: 'openid email profile',
      groupsClaim: 'groups',
      linkByEmail: false,
      adminGroups: ['cenacle-admins'],
      guestGroups: [],
    },
  });
  const upstream = new Provider(upstreamIssuer, {
    clients: [
      {
        client_id: 'cenacle-id',
        client_secret: secret,
        redirect_uris: [`${h.issuer}/federation/${source.id}/callback`],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_basic',
      },
    ],
    pkce: { required: () => true },
    features: { devInteractions: { enabled: true } },
    cookies: { keys: ['upstream-cookie-key-0123456789abcdef'] },
    // Groups come with the profile scope here (as with many providers).
    claims: { openid: ['sub'], email: ['email', 'email_verified'], profile: ['name', 'groups'] },
    async findAccount(_ctx, id) {
      return {
        accountId: id,
        async claims() {
          return {
            sub: id,
            email: 'ada@upstream.example',
            email_verified: true,
            name: 'Ada Upstream',
            groups: ['engineering', 'cenacle-admins'],
          };
        },
      };
    },
  });
  upstreamServer.on('request', upstream.callback());

  const { config, verifier, state } = await startAuthorization(page);
  await axe(page);
  await page.getByRole('link', { name: 'Continue with Upstream' }).click();
  // The provider's own (development) pages: any login, then consent.
  await page.locator('input[name="login"]').fill('ada');
  await page.locator('input[name="password"]').fill('anything');
  await page.locator('button[type="submit"]').click();
  await page.locator('button[type="submit"]').click();
  await expect(page.getByText('client callback')).toBeVisible();

  const tokens = await client.authorizationCodeGrant(
    config,
    new URL(`${h.callbackUrl}?${h.callbacks.at(-1)!.toString()}`),
    { pkceCodeVerifier: verifier, expectedState: state },
  );
  const info = await client.fetchUserInfo(config, tokens.access_token, client.skipSubjectCheck);
  expect(info).toMatchObject({ email: 'ada@upstream.example', name: 'Ada Upstream' });
  const { rows } = await h.pool.query(
    `SELECT u.directory_role, array_agg(g.name ORDER BY g.name) AS groups FROM users u
     JOIN user_groups ug ON ug.user_id = u.id JOIN directory_groups g ON g.id = ug.group_id
     WHERE u.source_id = $1 AND u.external_id = 'ada' GROUP BY u.id`,
    [source.id],
  );
  expect(rows).toEqual([{ directory_role: 'admin', groups: ['cenacle-admins', 'engineering'] }]);
});

// --- SAML ----------------------------------------------------------------------

const IDP_ENTITY = 'https://saml.test/idp';

function certificate() {
  certDir = mkdtempSync(join(tmpdir(), 'cenacle-saml-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-subj',
      '/CN=saml.test',
      '-keyout',
      join(certDir, 'key.pem'),
      '-out',
      join(certDir, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  return {
    key: readFileSync(join(certDir, 'key.pem'), 'utf8'),
    cert: readFileSync(join(certDir, 'cert.pem'), 'utf8'),
  };
}

/** A signed SAML response to an AuthnRequest. */
function samlResponse(o: {
  key: string;
  cert: string;
  requestId: string;
  acs: string;
  audience: string;
  nameId: string;
  email: string;
}): string {
  const now = new Date();
  const later = new Date(now.getTime() + 5 * 60_000);
  const id = (p: string) => `_${p}${Math.random().toString(16).slice(2)}`;
  const assertionId = id('a');
  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id('r')}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${o.acs}" InResponseTo="${o.requestId}"><saml:Issuer>${IDP_ENTITY}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${now.toISOString()}"><saml:Issuer>${IDP_ENTITY}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${o.nameId}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${later.toISOString()}" Recipient="${o.acs}" InResponseTo="${o.requestId}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${now.toISOString()}" NotOnOrAfter="${later.toISOString()}"><saml:AudienceRestriction><saml:Audience>${o.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${now.toISOString()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${o.email}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="displayName"><saml:AttributeValue>Grace SAML</saml:AttributeValue></saml:Attribute><saml:Attribute Name="memberOf"><saml:AttributeValue>staff</saml:AttributeValue><saml:AttributeValue>contractors</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion></samlp:Response>`;
  const sig = new SignedXml({
    privateKey: o.key,
    publicCert: o.cert,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  sig.addReference({
    xpath: `//*[@ID='${assertionId}']`,
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
  });
  sig.computeSignature(xml, {
    location: { reference: `//*[@ID='${assertionId}']/*[local-name(.)='Issuer']`, action: 'after' },
  });
  return sig.getSignedXml();
}

test('signing in to the account page with a SAML provider', async ({ page }) => {
  const { key, cert } = certificate();
  const idp = createServer();
  const port = await listen(idp);
  const source = await h.providers.create({
    kind: 'saml',
    name: 'Test SAML',
    enabled: true,
    secret: '',
    config: {
      entryPoint: `http://localhost:${port}/sso`,
      idpEntityId: IDP_ENTITY,
      idpCert: cert,
      emailAttribute: 'email',
      nameAttribute: 'displayName',
      groupsAttribute: 'memberOf',
      trustEmail: true,
      linkByEmail: false,
      adminGroups: [],
      guestGroups: ['contractors'],
    },
  });
  const acs = `${h.issuer}/federation/${source.id}/acs`;
  let tamper = false;
  idp.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const request = inflateRawSync(
      Buffer.from(url.searchParams.get('SAMLRequest') ?? '', 'base64'),
    ).toString();
    const requestId = /ID="([^"]+)"/.exec(request)![1]!;
    let response = samlResponse({
      key,
      cert,
      requestId,
      acs,
      audience: `${h.issuer}/federation/${source.id}`,
      nameId: 'grace-0001',
      email: 'grace@saml.example',
    });
    // Changed after signing: the signature no longer holds.
    if (tamper) response = response.replace('grace-0001', 'mallory-01');
    res.writeHead(200, { 'content-type': 'text/html' }).end(
      `<!doctype html><title>Test IdP</title><form method="post" action="${acs}">
        <input type="hidden" name="SAMLResponse" value="${Buffer.from(response).toString('base64')}">
        <input type="hidden" name="RelayState" value="${url.searchParams.get('RelayState') ?? ''}">
        <button type="submit">Send to Cenacle ID</button></form>`,
    );
  });

  // In metadata for registering Cenacle ID at the provider.
  const metadata = await (await fetch(`${h.issuer}/federation/${source.id}/metadata`)).text();
  expect(metadata).toContain(acs);

  await page.goto(`${h.issuer}/account`);
  await page.getByRole('link', { name: 'Continue with Test SAML' }).click();
  await page.getByRole('button', { name: 'Send to Cenacle ID' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your Cenacle ID');
  await expect(page.getByText('grace@saml.example')).toBeVisible();
  const { rows } = await h.pool.query(
    'SELECT display_name, directory_role FROM users WHERE source_id = $1',
    [source.id],
  );
  expect(rows).toEqual([{ display_name: 'Grace SAML', directory_role: 'guest' }]);

  // A response changed on its way is refused.
  await page.getByRole('button', { name: 'Sign out of Cenacle ID' }).click();
  tamper = true;
  await page.getByRole('link', { name: 'Continue with Test SAML' }).click();
  await page.getByRole('button', { name: 'Send to Cenacle ID' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Signing in with the other provider did not work.',
  );
});
