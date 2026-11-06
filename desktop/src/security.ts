// SPDX-License-Identifier: AGPL-3.0-only
import type { Session, WebContents } from 'electron';

export interface MediaPermissions {
  trusted: (contents: WebContents | null, requestingURL: string, mainFrame: boolean) => boolean;
  request: (contents: WebContents, types: readonly string[]) => Promise<boolean>;
  display: NonNullable<Parameters<Session['setDisplayMediaRequestHandler']>[0]>;
}

const hardened = new WeakSet<Session>();

/**
 * Locks a session down: media only through a trusted, prompted main frame;
 * no location/USB rights, notifications only where allowed, and no
 * downloads without the save dialog.
 */
export function hardenSession(
  ses: Session,
  opts: { allowNotifications: boolean; media?: MediaPermissions },
): void {
  if (hardened.has(ses)) return;
  hardened.add(ses);
  const allowed = (permission: string) =>
    (opts.allowNotifications && permission === 'notifications') ||
    permission === 'clipboard-sanitized-write';
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (
      permission === 'media' ||
      permission === 'display-capture' ||
      permission === 'speaker-selection'
    ) {
      if (!wc || !opts.media?.trusted(wc, details.requestingUrl, details.isMainFrame)) {
        callback(false);
        return;
      }
      if (permission === 'display-capture' || permission === 'speaker-selection') {
        callback(true);
        return;
      }
      const types = 'mediaTypes' in details ? details.mediaTypes : [];
      // getDisplayMedia asks for "media" with no types; the display handler then
      // asks the person with its picker (after a click, video only).
      if (permission === 'media' && Array.isArray(types) && types.length === 0) {
        callback(true);
        return;
      }
      if (!validMediaTypes(types)) {
        callback(false);
        return;
      }
      void opts.media.request(wc, types).then(callback, () => callback(false));
      return;
    }
    callback(allowed(permission));
  });
  ses.setPermissionCheckHandler((wc, permission, origin, details) => {
    if (permission === 'media') return false; // Native consent on every capture request.
    if (permission === 'display-capture' || permission === 'speaker-selection') {
      return !!opts.media?.trusted(wc, details.requestingUrl ?? origin, details.isMainFrame);
    }
    return allowed(permission);
  });
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler(opts.media?.display ?? ((_req, callback) => callback(null)));
  // Downloads ask where to save (the default without a path); nothing is opened.
  ses.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ defaultPath: item.getFilename() });
  });
}

export function validMediaTypes(types: unknown): types is ('audio' | 'video')[] {
  return (
    Array.isArray(types) &&
    types.length > 0 &&
    types.length <= 2 &&
    types.every((type) => type === 'audio' || type === 'video')
  );
}

export function trustedMediaOrigin(
  server: string,
  requestingURL: string,
  mainURL: string,
  mainFrame: boolean,
): boolean {
  if (!mainFrame || !server || originOf(requestingURL) !== server || originOf(mainURL) !== server)
    return false;
  const url = new URL(server);
  return url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/** The origin of a URL, or null for anything that is not http(s). */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Where a cenacle:// link leads: cenacle://open/<path> names a page of the
 * paired server, nothing else. Never another site ("//host" and "/\\host"
 * would name one) and never the server's API or WebSocket, which a link from
 * outside must not reach. null when the link leads nowhere.
 */
export function deepLinkTarget(link: string, server: string): string | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== 'cenacle:' || url.host !== 'open' || !server) return null;
  let target: URL;
  try {
    target = new URL(url.pathname.replace(/^[/\\]+/, '/') + url.search, server);
  } catch {
    return null;
  }
  if (target.origin !== server) return null;
  // The server decodes the path ("/%61pi" is "/api"): check what it will see.
  let path: string;
  try {
    path = decodeURIComponent(target.pathname);
  } catch {
    return null;
  }
  if (/^[/\\]*(api|ws)([/\\]|$)/i.test(path)) return null;
  return target.toString();
}

/**
 * A path of the paired server that a page asked to return to ("/" when it
 * names anything else: "//host" and "/\\host" are other sites).
 */
export function returnPath(returnTo: unknown, server: string): string {
  if (typeof returnTo !== 'string' || !returnTo.startsWith('/')) return '/';
  try {
    const url = new URL(returnTo, server);
    return url.origin === server ? url.pathname + url.search + url.hash : '/';
  } catch {
    return '/';
  }
}

/**
 * The origin of Cenacle ID as the server names it: the server's sign-in
 * (`/api/auth/login`) redirects to its issuer, and only that hop counts.
 * Pages that the sign-in visits afterwards (an organization's own sign-in
 * provider, or any site a page there links to) never become Cenacle ID.
 * null for every other step of the sign-in.
 */
export function issuerOrigin(server: string, from: string, to: string): string | null {
  let source: URL;
  try {
    source = new URL(from);
  } catch {
    return null;
  }
  if (source.origin !== server || source.pathname !== '/api/auth/login') return null;
  const origin = originOf(to);
  return origin && origin !== server ? origin : null;
}
