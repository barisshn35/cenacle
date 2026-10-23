// SPDX-License-Identifier: AGPL-3.0-only
// A stand-in chat server and Cenacle ID for the desktop app's tests: the
// desktop sign-in (challenge, one-time code, verifier), a bearer-only API,
// the web app turned off, and pages that use the app's bridge.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Fake {
  chat: string;
  idp: string;
  other: string;
  /** Authorization headers the chat server saw, in order. */
  authorizations: (string | undefined)[];
  cookies: (string | undefined)[];
  /** Exchanges that were refused. */
  refused: number;
  close: () => Promise<void>;
}

const TOKEN = 'session-token-of-ayse';

const html = (body: string, script = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Cenacle</title></head><body>${body}<script>${script}</script></body></html>`;

function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<[Server, string]> {
  return new Promise((resolve) => {
    const s = createServer(handler);
    s.listen(0, '127.0.0.1', () =>
      resolve([s, `http://127.0.0.1:${(s.address() as AddressInfo).port}`]),
    );
  });
}

const body = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });

export async function startFake(): Promise<Fake> {
  const state = {
    challenge: '',
    code: '',
    authorizations: [] as (string | undefined)[],
    cookies: [] as (string | undefined)[],
    refused: 0,
  };
  const fake = {} as Fake;

  const [other, otherUrl] = await listen((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      html(
        '<h1>A news site</h1>',
        `document.body.dataset.bridge = String('cenacleDesktop' in window);`,
      ),
    );
  });

  const [idp, idpUrl] = await listen(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && url.pathname === '/login') {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        html(
          `<h1>Sign in</h1><form method="post" action="/login"><label>Username <input name="username"></label><label>Password <input name="password" type="password"></label><button>Sign in</button></form>`,
        ),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/login') {
      const form = new URLSearchParams(await body(req));
      if (form.get('password') !== 'correct horse') {
        res.writeHead(302, { Location: `${fake.chat}/signin?error=failed` }).end();
        return;
      }
      res.writeHead(302, { Location: `${fake.chat}/api/auth/callback?ok=1` }).end();
      return;
    }
    if (url.pathname === '/account') {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        html(
          '<h1>Your Cenacle ID</h1>',
          `document.body.dataset.bridge = String('cenacleDesktop' in window);`,
        ),
      );
      return;
    }
    res.writeHead(404).end();
  });

  const [chat, chatUrl] = await listen(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname.startsWith('/api/')) {
      state.authorizations.push(req.headers.authorization);
      state.cookies.push(req.headers.cookie);
    }
    const signedIn = req.headers.authorization === `Bearer ${TOKEN}`;
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    switch (url.pathname) {
      case '/api/meta':
        // Browsers are turned away here; the desktop app is not.
        return json(200, { web_app: false, desktop_min_version: '' });
      case '/api/session':
        return signedIn
          ? json(200, { user: { display_name: 'Ayşe Yılmaz' } })
          : json(401, { code: 'unauthenticated' });
      case '/api/auth/login':
        state.challenge = url.searchParams.get('desktop') ?? '';
        res.writeHead(302, { Location: `${idpUrl}/login` }).end();
        return;
      case '/api/auth/callback':
        state.code = `code-${Date.now()}`;
        res.writeHead(302, { Location: `${chatUrl}/desktop/signed-in?code=${state.code}` }).end();
        return;
      case '/api/auth/desktop/token': {
        const { code, verifier } = JSON.parse(await body(req)) as {
          code: string;
          verifier: string;
        };
        const ok =
          code === state.code &&
          createHash('sha256').update(verifier).digest('base64url') === state.challenge;
        state.code = '';
        if (!ok) {
          state.refused++;
          return json(400, { code: 'invalid_code' });
        }
        return json(200, { token: TOKEN, expires_at: '2126-01-01T00:00:00Z' });
      }
      case '/api/auth/logout':
        return json(200, { end_session_url: '' });
      case '/api/files/report.txt':
        res.writeHead(signedIn ? 200 : 401, { 'Content-Type': 'text/plain' });
        res.end(signedIn ? 'the report' : '');
        return;
      default:
        // The "web app": asks for the session and signs in through the bridge.
        res.setHeader('Content-Type', 'text/html');
        res.end(
          html(
            `<main><h1 id="who">…</h1><a id="external" href="${otherUrl}/news" target="_blank">News</a> <a id="account" href="${idpUrl}/account" target="_blank">Your account</a> <a id="file" href="/api/files/report.txt" target="_blank">report.txt</a> <button id="signout">Sign out</button></main>`,
            `
            const bridge = window.cenacleDesktop;
            document.body.dataset.bridgeKeys = bridge ? Object.keys(bridge).sort().join(',') : '';
            document.getElementById('signout').onclick = () => bridge.signOut();
            fetch('/api/session').then(async (r) => {
              if (r.status === 401) { document.getElementById('who').textContent = 'Signed out'; bridge.signIn(location.pathname); return; }
              const s = await r.json();
              document.getElementById('who').textContent = 'Signed in as ' + s.user.display_name;
            });`,
          ),
        );
    }
  });

  Object.assign(fake, {
    chat: chatUrl,
    idp: idpUrl,
    other: otherUrl,
    get authorizations() {
      return state.authorizations;
    },
    get cookies() {
      return state.cookies;
    },
    get refused() {
      return state.refused;
    },
    close: async () => {
      for (const s of [chat, idp, other]) await new Promise((r) => s.close(r));
    },
  });
  return fake;
}

export { TOKEN };
