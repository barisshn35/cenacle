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
});
