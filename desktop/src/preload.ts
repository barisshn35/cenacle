// SPDX-License-Identifier: AGPL-3.0-only
// The bridge between the server's pages and the app: a few named actions,
// never the session token or anything of Node.
import { contextBridge, ipcRenderer } from 'electron';

const version = process.argv.find((a) => a.startsWith('--cenacle-version='))?.split('=')[1] ?? '';

contextBridge.exposeInMainWorld('cenacleDesktop', {
  version,
  platform: process.platform,
  /** Opens the sign-in window; afterwards the app opens `returnTo`. */
  signIn: (returnTo: string) => ipcRenderer.invoke('desktop:sign-in', returnTo),
  /** Ends the session on the server and in the app. */
  signOut: () => ipcRenderer.invoke('desktop:sign-out'),
  changeServer: () => ipcRenderer.invoke('desktop:change-server'),
  /** The count on the taskbar or dock (0 clears it). */
  setBadge: (count: number) => ipcRenderer.invoke('desktop:badge', count),
  /** Shows a system notification; a click brings the app back to `channelId`. */
  notify: (note: { title: string; body: string; channelId?: string }) =>
    ipcRenderer.invoke('desktop:notify', note),
  /** Called with the channel of a notification the person clicked. */
  onNotificationClick: (listener: (channelId: string) => void) => {
    const handler = (_: unknown, channelId: unknown) => {
      if (typeof channelId === 'string') listener(channelId);
    };
    ipcRenderer.on('desktop:notification-click', handler);
    return () => ipcRenderer.removeListener('desktop:notification-click', handler);
  },
  /** The colors of the page's bar; the window's buttons take them. */
  setTitleBar: (colors: { color: string; symbolColor: string }) =>
    ipcRenderer.invoke('desktop:title-bar', colors),
  /** The app's own settings: { closeToTray, sessionKept, tray }. */
  prefs: () => ipcRenderer.invoke('desktop:prefs'),
  setCloseToTray: (on: boolean) => ipcRenderer.invoke('desktop:set-close-to-tray', on),
  checkUpdates: () => ipcRenderer.invoke('desktop:check-updates'),
  /** The height of the window's bar in pixels (its buttons sit at the right of it). */
  titleBarHeight: 36,
});
