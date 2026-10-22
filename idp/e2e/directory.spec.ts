// SPDX-License-Identifier: AGPL-3.0-only
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import * as client from 'openid-client';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  DATABASE_URL,
  EMAIL,
  PASSWORD,
  startHarness,
  type Harness,
} from './harness.ts';

/** The development OpenLDAP (deploy/compose/ldap). */
const LDAP_URL = process.env.IDP_TEST_LDAP_URL;
const LDAP_PASSWORD = process.env.IDP_TEST_LDAP_PASSWORD ?? '';

test.skip(!DATABASE_URL || !LDAP_URL, 'IDP_TEST_DATABASE_URL or IDP_TEST_LDAP_URL is not set');
test.describe.configure({ mode: 'serial' });

let h: Harness;
test.beforeAll(async () => {
  h = await startHarness({
    loginRateLimit: 1000,
    directory: true,
    scope: 'openid email profile groups',
  });
});
test.afterAll(async () => {
  await h?.close();
});

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .options({
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      rules: { 'target-size': { enabled: true } },
    })
    .analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([]);
}

test('an administrator connects a directory, tests, previews and synchronizes it', async ({
  page,
}) => {
  await page.goto(`${h.issuer}/account`);
  await page.getByLabel('E-mail address').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'Administration' }).click();
  await expect(page.getByRole('cell', { name: /Ayşe Yılmaz/ })).toBeVisible();
  await axe(page);

  await page.getByRole('link', { name: 'Directories' }).click();
  await expect(page.getByText('No directory is connected.')).toBeVisible();
  await page.getByLabel('Kind').selectOption('openldap');
  await page.getByRole('button', { name: 'Connect a directory' }).click();
  await page.getByLabel('Directory name').fill('Test LDAP');
  await page.getByLabel('Server addresses').fill(LDAP_URL!);
  await page.getByLabel('Service account (bind DN)').fill('cn=admin,dc=cenacle,dc=test');
  await page.getByLabel('Service account password').fill(LDAP_PASSWORD);
  await page.getByLabel('Search base', { exact: true }).fill('ou=people,dc=cenacle,dc=test');
  await page
    .getByLabel('Who may sign in (filter)')
    .fill('(&(objectClass=inetOrgPerson)(!(description=disabled)))');
  await page
    .getByLabel('Search base (empty: the people search base)')
    .fill('ou=groups,dc=cenacle,dc=test');
  await page.getByLabel('Administrators (filter, optional)').fill('(title=Platform Lead)');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  await axe(page);

  await page.getByRole('button', { name: 'Test the connection' }).click();
  await expect(page.getByText('Connected: 4 people and 5 groups found.')).toBeVisible();

  await page.getByLabel('Sign-in name', { exact: true }).fill('alice');
  await page.getByRole('button', { name: 'Show' }).click();
  const preview = page.getByRole('region', { name: 'As Cenacle ID will see them' });
  await expect(preview).toContainText('Alice Admin');
  await expect(preview).toContainText('Administrator');
  await expect(preview).toContainText('cenacle-admins, engineering, staff');

  await page.getByRole('button', { name: 'Synchronize now' }).click();
  await expect(page.getByText(/Synchronized: 4 people, 4 new/)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Recent synchronizations' })).toContainText(
    'succeeded',
  );
});

test('people sign in to apps with their directory password and get groups', async ({ page }) => {
  const config = await client.discovery(
    new URL(h.issuer),
    CLIENT_ID,
    undefined,
    client.ClientSecretBasic(CLIENT_SECRET),
    {
      execute: [client.allowInsecureRequests],
    },
  );
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: h.callbackUrl,
    scope: 'openid email profile groups',
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
  });
  await page.goto(url.href);
  // With a directory, the field takes a username too.
  await page.getByLabel('E-mail address or username').fill('carol');
  await page.getByLabel('Password').fill('wrong password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'The username, e-mail address or password is incorrect.',
  );
  await page.getByLabel('Password').fill('carol-dev-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect.poll(() => h.callbacks.length).toBeGreaterThan(0);
  const tokens = await client.authorizationCodeGrant(
    config,
    new URL(`${h.callbackUrl}?${h.callbacks.at(-1)}`),
    {
      pkceCodeVerifier: verifier,
      expectedState: state,
    },
  );
  const info = await client.fetchUserInfo(config, tokens.access_token, tokens.claims()!.sub);
  expect(info).toMatchObject({
    name: 'Carol Designer',
    preferred_username: 'carol',
    email: 'carol@cenacle.test',
    groups: ['design', 'staff'],
  });
});
