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
