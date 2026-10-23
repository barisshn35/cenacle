// SPDX-License-Identifier: AGPL-3.0-only
import { app, dialog, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { fill, t } from './i18n.js';

let serverOf: () => string | null = () => null;
let windowOf: () => BrowserWindow | null = () => null;
let asked = false;

/**
 * Updates come from the paired server only: its administrators put the
 * installers and the update files (latest.yml, latest-linux.yml) under
 * /downloads/desktop/. Nothing else is asked, and nothing is sent.
 */
export function setupUpdates(server: () => string | null, win: () => BrowserWindow | null): void {
  serverOf = server;
  windowOf = win;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;
  autoUpdater.on('update-available', (info) => void offer(info.version));
  autoUpdater.on('update-downloaded', (info) => void ready(info.version));
  // Once a while after the start, then every six hours.
  setTimeout(() => void checkForUpdates(false), 60_000);
  setInterval(() => void checkForUpdates(false), 6 * 60 * 60_000);
}

export async function checkForUpdates(manual: boolean): Promise<void> {
  const server = serverOf();
  if (!server || !app.isPackaged) return;
  autoUpdater.setFeedURL({ provider: 'generic', url: `${server}/downloads/desktop` });
  asked = manual;
  try {
    const result = await autoUpdater.checkForUpdates();
    if (manual && (!result || !result.isUpdateAvailable)) await show(t().update.none);
  } catch {
    if (manual) await show(t().update.failed);
  }
}

async function show(message: string, detail?: string) {
  const win = windowOf();
  const opts = { type: 'info' as const, message, detail, buttons: [t().update.ok] };
  await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
}

async function offer(version: string) {
  const u = t().update;
  const win = windowOf();
  const opts = {
    type: 'info' as const,
    message: fill(u.availableTitle, { version }),
    detail: u.available,
    buttons: [u.download, u.later],
    defaultId: 0,
    cancelId: 1,
  };
  const { response } = await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
  if (response === 0) await autoUpdater.downloadUpdate();
  else if (asked) asked = false;
}

async function ready(version: string) {
  const u = t().update;
  const win = windowOf();
  const opts = {
    type: 'info' as const,
    message: fill(u.readyTitle, { version }),
    detail: u.ready,
    buttons: [u.restart, u.later],
    defaultId: 0,
    cancelId: 1,
  };
  const { response } = await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
  if (response === 0) autoUpdater.quitAndInstall();
}
