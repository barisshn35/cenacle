// SPDX-License-Identifier: AGPL-3.0-only
import type { BrowserWindow } from 'electron';
import { showDialog } from './dialog.js';
import { autoUpdater } from 'electron-updater';
import { fill, t } from './i18n.js';
import { SignedProvider } from './update-provider.js';

let serverOf: () => string | null = () => null;
let windowOf: () => BrowserWindow | null = () => null;
let asked = false;
let enabled = false;

/**
 * Updates come from the paired server only: its administrators put the
 * installers and the update files (latest.yml, latest-linux.yml) under
 * /downloads/desktop/. Nothing else is asked, and nothing is sent. An update
 * is taken only when the release key built into the app signed its update
 * file (SignedProvider): the server hosts updates, it cannot make them.
 */
export function setupUpdates(
  server: () => string | null,
  win: () => BrowserWindow | null,
  on: boolean,
): void {
  serverOf = server;
  windowOf = win;
  enabled = on;
  if (!on) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;
  // Whole installers only: the signed update file names their sha512, the
  // pieces of a differential download (blockmaps) are not signed.
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.on('update-available', (info) => void offer(info.version));
  autoUpdater.on('update-downloaded', (info) => void ready(info.version));
  // Once a while after the start, then every six hours.
  setTimeout(() => void checkForUpdates(false), 60_000);
  setInterval(() => void checkForUpdates(false), 6 * 60 * 60_000);
}

export async function checkForUpdates(manual: boolean): Promise<void> {
  const server = serverOf();
  if (!server || !enabled) return;
  autoUpdater.setFeedURL({
    provider: 'custom',
    updateProvider: SignedProvider,
    url: `${server}/downloads/desktop`,
  });
  asked = manual;
  try {
    const result = await autoUpdater.checkForUpdates();
    if (manual && (!result || !result.isUpdateAvailable)) await show(t().update.none);
  } catch (err) {
    if (!manual) return;
    // A server that hosts no updates has no update file: say so, it is not a fault.
    const missing =
      (err as { code?: unknown } | null)?.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND';
    if (missing) await show(t().update.notHosted, t().update.notHostedHint);
    else await show(t().update.failed);
  }
}

async function show(message: string, detail?: string) {
  const win = windowOf();
  const opts = {
    type: 'info' as const,
    message,
    detail,
    buttons: [t().update.ok],
  };
  await showDialog(win, opts);
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
  const response = await showDialog(win, opts);
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
  const response = await showDialog(win, opts);
  if (response === 0) autoUpdater.quitAndInstall();
}
