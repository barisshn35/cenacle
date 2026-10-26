// SPDX-License-Identifier: AGPL-3.0-only
import type { Session } from 'electron';

const hardened = new WeakSet<Session>();

/**
 * Locks a session down: no device permissions (camera, microphone,
 * location, screen, USB, …), notifications only where allowed, and no
 * downloads without the save dialog.
 */
export function hardenSession(ses: Session, opts: { allowNotifications: boolean }): void {
  if (hardened.has(ses)) return;
  hardened.add(ses);
  const allowed = (permission: string) =>
    (opts.allowNotifications && permission === 'notifications') ||
    permission === 'clipboard-sanitized-write';
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed(permission));
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_req, callback) => callback({}));
  // Downloads ask where to save (the default without a path); nothing is opened.
  ses.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ defaultPath: item.getFilename() });
  });
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
