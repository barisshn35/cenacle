// SPDX-License-Identifier: AGPL-3.0-only
import { net, session, type BrowserWindow, type Session, type WebContentsView } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { hardenSession, issuerOrigin } from './security.js';

export type SignInResult =
  | { token: string }
  | { error: 'cancelled' | 'expired' | 'failed' | 'unavailable' | 'exchange' | 'closed' };

/** The partition of the sign-in window: in memory only, fresh each time. */
const SIGNIN_PARTITION = 'cenacle-signin';

const base64url = (b: Buffer) => b.toString('base64url');

/**
 * Signs in in a window of the app (never a browser): the window opens the
 * server's sign-in for the desktop app, which leads to Cenacle ID's page
 * (username, password, code). The window's bar shows whose page it is; the
 * page has no access to the app, and nothing is kept afterwards. Where the
 * sign-in ends, the window stops and the app exchanges the one-time code
 * with the verifier only it knows (PKCE S256) for the session token.
 */
export function signIn(opts: {
  server: string;
  parent: BrowserWindow | null;
  returnTo: string;
  /** Opens a window with the app's bar (the address of the page) around a page view. */
  frame: (ses: Session, parent?: BrowserWindow) => { win: BrowserWindow; view: WebContentsView };
  /** Called with the origin of Cenacle ID, where the server's sign-in redirects. */
  onIdentityProvider: (origin: string) => void;
}): Promise<SignInResult> {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const ses = session.fromPartition(SIGNIN_PARTITION);
  hardenSession(ses, { allowNotifications: false });
  // The bar shows the address of each page, so the person sees where the password goes.
  const { win, view } = opts.frame(ses, opts.parent ?? undefined);
  const page = view.webContents;

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

    const url = new URL('/api/auth/login', opts.server);
    url.searchParams.set('desktop', challenge);
    url.searchParams.set('return_to', opts.returnTo);

    const signedIn = `${opts.server}/desktop/signed-in`;
    const failedAt = `${opts.server}/signin`;
    // The address the top frame is at, to tell which step a redirect leaves.
    let current = url.toString();
    const follow = (event: { preventDefault: () => void }, target: string, redirect: boolean) => {
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
      try {
        new URL(target);
      } catch {
        event.preventDefault();
        return;
      }
      // Cenacle ID is where the server's sign-in redirects, never just any
      // page the sign-in window visits (links there open in Cenacle ID's window).
      const issuer = redirect ? issuerOrigin(opts.server, current, target) : null;
      if (issuer) opts.onIdentityProvider(issuer);
      current = target;
    };
    page.on('will-redirect', (event) => {
      if (event.isMainFrame) follow(event, event.url, true);
    });
    page.on('will-navigate', (event) => follow(event, event.url, false));
    // No pop-ups from the sign-in pages.
    page.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => finish({ error: 'closed' }));

    void page.loadURL(url.toString());
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
