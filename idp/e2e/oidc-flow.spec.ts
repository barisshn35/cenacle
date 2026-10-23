// SPDX-License-Identifier: AGPL-3.0-only
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
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

test.skip(!DATABASE_URL, 'IDP_TEST_DATABASE_URL is not set');
test.describe.configure({ mode: 'serial' });

let h: Harness;
test.beforeAll(async () => {
  // Rate limiting has its own spec with a low limit.
  h = await startHarness({ loginRateLimit: 1000 });
});
test.afterAll(async () => {
  await h?.close();
});

async function rp(): Promise<client.Configuration> {
  return client.discovery(
    new URL(h.issuer),
    CLIENT_ID,
    undefined,
    client.ClientSecretBasic(CLIENT_SECRET),
    { execute: [client.allowInsecureRequests] },
  );
}

async function startAuthorization(page: Page) {
  const config = await rp();
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

async function submitLogin(page: Page, email: string, password: string) {
  await page.getByLabel('E-mail address').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function signIn(page: Page) {
  const auth = await startAuthorization(page);
  await submitLogin(page, EMAIL, PASSWORD);
  await page.waitForURL((u) => u.href.startsWith(h.callbackUrl));
  const tokens = await client.authorizationCodeGrant(auth.config, new URL(page.url()), {
    pkceCodeVerifier: auth.verifier,
    expectedState: auth.state,
  });
  return { ...auth, tokens };
}

test('authorization code flow with PKCE issues verified tokens', async ({ page }) => {
  const { config, tokens } = await signIn(page);

  const claims = tokens.claims()!;
  // Code flow: the ID token carries identity only; profile claims come from
  // userinfo (OIDC Core 5.4, oidc-provider conformIdTokenClaims).
  expect(claims).toMatchObject({ iss: h.issuer, aud: CLIENT_ID });
  expect(claims.email).toBeUndefined();
  expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);

  const header = decodeProtectedHeader(tokens.id_token!);
  const [active] = await h.keys.list();
  expect(header).toMatchObject({ alg: 'RS256', kid: active!.kid });

  const info = await client.fetchUserInfo(config, tokens.access_token, claims.sub);
  expect(info).toMatchObject({
    sub: claims.sub,
    email: EMAIL,
    email_verified: true,
    name: 'Ayşe Yılmaz',
  });
});

test('an authorization code works only once', async ({ page }) => {
  const auth = await startAuthorization(page);
  await submitLogin(page, EMAIL, PASSWORD);
  await page.waitForURL((u) => u.href.startsWith(h.callbackUrl));
  const current = new URL(page.url());
  const checks = { pkceCodeVerifier: auth.verifier, expectedState: auth.state };
  await client.authorizationCodeGrant(auth.config, current, checks);
  await expect(client.authorizationCodeGrant(auth.config, current, checks)).rejects.toThrow();
});

test('wrong credentials get one message for unknown and known accounts', async ({ page }) => {
  await startAuthorization(page);
  await submitLogin(page, EMAIL, 'a wrong but long passphrase');
  const known = await page.getByRole('alert').textContent();
  await expect(page.getByLabel('Password')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('E-mail address')).toHaveValue(EMAIL);

  await submitLogin(page, 'nobody@example.com', 'a wrong but long passphrase');
  const unknown = await page.getByRole('alert').textContent();
  expect(unknown).toBe(known);
  expect(known).toContain('E-mail address or password is incorrect.');
});

test('cancelling returns access_denied to the client', async ({ page }) => {
  const { state } = await startAuthorization(page);
  await page.getByRole('button', { name: /^Cancel and go back to / }).click();
  await page.waitForURL((u) => u.href.startsWith(h.callbackUrl));
  const params = new URL(page.url()).searchParams;
  expect(params.get('error')).toBe('access_denied');
  expect(params.get('state')).toBe(state);
});

test('cross-site form posts are rejected', async ({ page, request }) => {
  await startAuthorization(page);
  const action = await page.locator('form').first().getAttribute('action');
  const res = await request.post(`${h.issuer}${action}`, {
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    form: { email: EMAIL, password: PASSWORD },
  });
  expect(res.status()).toBe(403);
});

test('sign-in pages follow the language of the browser and can switch it', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'tr-TR' });
  const page = await context.newPage();
  await startAuthorization(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Giriş yap');
  await page.getByRole('link', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
  await context.close();
});

test('the sign-in page meets target size and WCAG 2.2 AA (axe)', async ({ page }) => {
  await startAuthorization(page);
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  const min = coarse ? 44 : 24;
  const sizes = await page.locator('input, button, a[href]').evaluateAll((els) =>
    els
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { name: el.outerHTML.slice(0, 60), w: r.width, h: r.height };
      }),
  );
  // Visually hidden helpers (the skip link) are measured when focused, below.
  const visible = sizes.filter((s) => s.w > 1 || s.h > 1);
  expect(visible.length).toBeGreaterThan(3);
  expect(visible.filter((s) => Math.min(s.w, s.h) < min - 0.5)).toEqual([]);

  const skip = page.getByRole('link', { name: 'Skip to content' });
  await skip.focus();
  const box = (await skip.boundingBox())!;
  expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(min - 0.5);

  const { violations } = await new AxeBuilder({ page })
    .options({
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      rules: { 'target-size': { enabled: true } },
    })
    .analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
});

test('RP-initiated logout asks for confirmation and returns to the client', async ({ page }) => {
  const { config, tokens } = await signIn(page);
  const url = client.buildEndSessionUrl(config, {
    id_token_hint: tokens.id_token!,
    post_logout_redirect_uri: h.postLogoutUrl,
    state: 'bye',
  });
  await page.goto(url.href);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign out of Cenacle?');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForURL((u) => u.href.startsWith(h.postLogoutUrl));
  expect(new URL(page.url()).searchParams.get('state')).toBe('bye');
});

test('rotated keys keep earlier tokens verifiable', async ({ page }) => {
  const before = await signIn(page);
  const oldKid = decodeProtectedHeader(before.tokens.id_token!).kid;

  const { kid: newKid } = await h.keys.rotate();
  await h.restart();

  const jwks = createRemoteJWKSet(new URL(`${h.issuer}/jwks`));
  await expect(
    jwtVerify(before.tokens.id_token!, jwks, { issuer: h.issuer, audience: CLIENT_ID }),
  ).resolves.toBeTruthy();

  await page.context().clearCookies();
  const after = await signIn(page);
  expect(decodeProtectedHeader(after.tokens.id_token!).kid).toBe(newKid);
  expect(newKid).not.toBe(oldKid);
});
