// SPDX-License-Identifier: AGPL-3.0-only
import { queryOptions } from '@tanstack/react-query';

/** What the desktop app offers the web app (its preload); absent in browsers. */
export interface DesktopBridge {
  version: string;
  platform: string;
  signIn: (returnTo: string) => Promise<void>;
  signOut: () => Promise<void>;
  changeServer: () => Promise<void>;
  setBadge: (count: number) => Promise<void>;
  setTitleBar: (colors: { color: string; symbolColor: string }) => Promise<void>;
  prefs: () => Promise<DesktopPrefs | null>;
  setCloseToTray: (on: boolean) => Promise<void>;
  checkUpdates: () => Promise<void>;
  /** Shows a system notification (absent before 1.0's desktop app). */
  notify?: (note: { title: string; body: string; channelId?: string }) => Promise<void>;
  /** Calls `listener` with the channel of a clicked notification; returns the unsubscribe. */
  onNotificationClick?: (listener: (channelId: string) => void) => () => void;
  /** The height of the window's bar in pixels. */
  titleBarHeight: number;
}

export interface DesktopPrefs {
  closeToTray: boolean;
  sessionKept: boolean;
  tray: boolean;
  /** The app updates itself (not from the Microsoft Store, not turned off by policy). */
  updates?: boolean;
  /** The organization set the server and people cannot change it. */
  serverLocked?: boolean;
}

/** The desktop app around this page, or undefined in a browser. */
export const desktop: DesktopBridge | undefined = (globalThis as { cenacleDesktop?: DesktopBridge })
  .cenacleDesktop;

/** A desktop installer the server offers (/downloads/desktop/index.json). */
export interface DesktopDownload {
  file: string;
  platform: 'windows' | 'linux';
  /** 'x64', 'arm64', or both for the Windows installer. */
  arch: string;
  kind: 'installer' | 'msi' | 'appimage' | 'deb' | 'rpm';
  size: number;
}

/**
 * The desktop app's installers on this server, put there by its
 * administrators; null when there are none.
 */
export const downloadsQuery = queryOptions({
  queryKey: ['desktop-downloads'],
  queryFn: async () => {
    const res = await fetch('/downloads/desktop/index.json', { cache: 'no-cache' });
    if (!res.ok) return null;
    try {
      return (await res.json()) as { version: string; files: DesktopDownload[] };
    } catch {
      return null;
    }
  },
  staleTime: 5 * 60_000,
  retry: false,
});
