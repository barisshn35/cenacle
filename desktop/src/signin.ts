// SPDX-License-Identifier: AGPL-3.0-only
import { BrowserWindow, net, session } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { fill, t } from './i18n.js';
import { hardenSession } from './security.js';

export type SignInResult =
  | { token: string }
  | { error: 'cancelled' | 'expired' | 'failed' | 'unavailable' | 'exchange' | 'closed' };

/** The partition of the sign-in window: in memory only, fresh each time. */
const SIGNIN_PARTITION = 'cenacle-signin';

const base64url = (b: Buffer) => b.toString('base64url');

/**
 * Signs in in a window of the app (never a browser): the window opens the
 * server's sign-in for the desktop app, which leads to Cenacle ID's page
 * (username, password, code). The window shows whose page it is in its
 * title, has no access to the app, and keeps nothing afterwards. Where the
 * sign-in ends, the window stops and the app exchanges the one-time code
 * with the verifier only it knows (PKCE S256) for the session token.
 */
export function signIn(opts: {
  server: string;
  parent: BrowserWindow | null;
  returnTo: string;
  /** Called with the origin of each page of the sign-in that is not the server. */
  onIdentityProvider: (origin: string) => void;
}): Promise<SignInResult> {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const ses = session.fromPartition(SIGNIN_PARTITION);
  hardenSession(ses, { allowNotifications: false });

  const win = new BrowserWindow({
    width: 520,
    height: 720,
    minWidth: 400,
    minHeight: 560,
    parent: opts.parent ?? undefined,
    modal: false,
    show: false,
    autoHideMenuBar: true,
    title: fill(t().signIn.title, { host: new URL(opts.server).host }),
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.removeMenu();
  win.once('ready-to-show', () => win.show());

  return new Promise<SignInResult>((resolve) => {
    let done = false;
    const finish = (result: SignInResult) => {
      if (done) return;
      done = true;
      resolve(result);
      // Nothing of the sign-in stays: cookies, storage and cache go with the window.
      void ses.clearStorageData().then(() => ses.clearCache());
      if (!win.isDestroyed()) win.destroy();
    };

    const signedIn = `${opts.server}/desktop/signed-in`;
    const failedAt = `${opts.server}/signin`;
    const follow = (event: { preventDefault: () => void }, target: string) => {
      if (target.startsWith(signedIn)) {
        event.preventDefault();
        const code = new URL(target).searchParams.get('code') ?? '';
        void exchange(opts.server, code, verifier).then(finish);
        return;
      }
      if (target.startsWith(failedAt)) {
        // The server sends failures back to its sign-in page with a reason.
        event.preventDefault();
        const reason = new URL(target).searchParams.get('error');
        finish({
          error:
            reason === 'cancelled' || reason === 'expired' || reason === 'unavailable'
              ? reason
              : 'failed',
        });
        return;
      }
      let origin: string;
      try {
        origin = new URL(target).origin;
      } catch {
        event.preventDefault();
        return;
      }
      if (origin !== opts.server) opts.onIdentityProvider(origin);
    };
    win.webContents.on('will-redirect', follow);
    win.webContents.on('will-navigate', follow);
    // The title names whose page this is, so the person sees where the password goes.
    win.webContents.on('did-navigate', (_e, url) => {
      if (!win.isDestroyed()) win.setTitle(fill(t().signIn.title, { host: new URL(url).host }));
    });
    win.on('page-title-updated', (e) => e.preventDefault());
    // No pop-ups from the sign-in pages.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => finish({ error: 'closed' }));

    const url = new URL('/api/auth/login', opts.server);
    url.searchParams.set('desktop', challenge);
    url.searchParams.set('return_to', opts.returnTo);
    void win.loadURL(url.toString());
  });
}

/** Exchanges the one-time code of a desktop sign-in for the session token. */
async function exchange(server: string, code: string, verifier: string): Promise<SignInResult> {
  try {
    const res = await net.fetch(`${server}/api/auth/desktop/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, verifier }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { error: 'exchange' };
    const body = (await res.json()) as { token?: unknown };
    return typeof body.token === 'string' && body.token
      ? { token: body.token }
      : { error: 'exchange' };
  } catch {
    return { error: 'exchange' };
  }
}
