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
  prefs: () => Promise<{ closeToTray: boolean; sessionKept: boolean; tray: boolean } | null>;
  setCloseToTray: (on: boolean) => Promise<void>;
  checkUpdates: () => Promise<void>;
  /** The height of the window's bar in pixels. */
  titleBarHeight: number;
}

/** The desktop app around this page, or undefined in a browser. */
export const desktop: DesktopBridge | undefined = (globalThis as { cenacleDesktop?: DesktopBridge })
  .cenacleDesktop;

/** A desktop installer the server offers (/downloads/desktop/index.json). */
export interface DesktopDownload {
  file: string;
  platform: 'windows' | 'linux';
  arch: 'x64' | 'arm64';
  kind: 'installer' | 'appimage' | 'deb' | 'rpm';
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
