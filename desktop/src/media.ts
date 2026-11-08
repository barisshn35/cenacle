// SPDX-License-Identifier: AGPL-3.0-only
import { BrowserWindow, desktopCapturer, Menu, type WebContents } from 'electron';
import { showDialog } from './dialog.js';
import { t } from './i18n.js';
import { trustedMediaOrigin, type MediaPermissions } from './security.js';

/** All authority stays in main; no source ID, desktopCapturer or permission IPC bridge. */
export function mediaPermissions(scope: {
  window: () => BrowserWindow | null;
  server: () => string;
  signedIn: () => boolean;
}): MediaPermissions {
  const pending = new Set<number>();
  const trusted = (contents: WebContents | null, url: string, mainFrame: boolean) => {
    const window = scope.window();
    return (
      !!window &&
      !window.isDestroyed() &&
      !!contents &&
      !contents.isDestroyed() &&
      contents === window.webContents &&
      scope.signedIn() &&
      trustedMediaOrigin(scope.server(), url, contents.mainFrame.url, mainFrame)
    );
  };
  return {
    trusted,
    async request(contents, types) {
      const window = scope.window();
      if (!window || pending.has(contents.id) || !trusted(contents, contents.mainFrame.url, true))
        return false;
      pending.add(contents.id);
      const frame = contents.mainFrame;
      const url = frame.url;
      try {
        const text = t().calls;
        const names = types
          .map((type) => (type === 'audio' ? text.microphone : text.camera))
          .join(', ');
        const response = await showDialog(window, {
          type: 'question',
          message: text.permissionMessage.replace('{{host}}', new URL(scope.server()).host),
          detail: names,
          buttons: [text.deny, text.allow],
          cancelId: 0,
          defaultId: 0,
        });
        return (
          response === 1 &&
          contents.mainFrame === frame &&
          frame.url === url &&
          trusted(contents, url, true)
        );
      } catch {
        return false;
      } finally {
        pending.delete(contents.id);
      }
    },
    display(request, callback) {
      const window = scope.window();
      const frame = request.frame;
      if (
        !window ||
        !frame ||
        frame !== window.webContents.mainFrame ||
        !request.userGesture ||
        !request.videoRequested ||
        request.audioRequested ||
        !trusted(window.webContents, frame.url, frame === frame.top) ||
        pending.has(window.webContents.id)
      ) {
        callback(null);
        return;
      }
      const contents = window.webContents;
      const url = frame.url;
      pending.add(contents.id);
      let settled = false;
      let menu: Menu | undefined;
      const finish = (source: Electron.DesktopCapturerSource | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        menu?.closePopup(window);
        pending.delete(contents.id);
        try {
          callback(
            source &&
              request.frame === frame &&
              !window.isDestroyed() &&
              contents.mainFrame === frame &&
              frame.url === url &&
              trusted(contents, url, true)
              ? { video: source }
              : null,
          );
        } catch {
          /* Frame destruction revokes the request. */
        }
      };
      const timer = setTimeout(() => finish(null), 30000);
      void desktopCapturer
        .getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 64, height: 40 },
          fetchWindowIcons: false,
        })
        .then((sources) => {
          if (
            settled ||
            window.isDestroyed() ||
            frame.url !== url ||
            !trusted(contents, url, true)
          ) {
            finish(null);
            return;
          }
          if (sources.length > 128) {
            finish(null);
            return;
          }
          const text = t().calls;
          menu = Menu.buildFromTemplate([
            { label: text.chooseScreen, enabled: false },
            { type: 'separator' },
            ...sources.map((source) => ({
              label: [...source.name]
                .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char))
                .join('')
                .slice(0, 100),
              icon: source.thumbnail.isEmpty() ? undefined : source.thumbnail.resize({ width: 48 }),
              click: () => finish(source),
            })),
            { type: 'separator' },
            { label: text.cancel, click: () => finish(null) },
          ]);
          // The close callback can come before the chosen item's click: cancel a moment later.
          menu.popup({ window, callback: () => setTimeout(() => finish(null), 300) });
        })
        .catch(() => finish(null));
    },
  };
}
