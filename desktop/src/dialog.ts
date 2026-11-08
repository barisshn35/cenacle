// SPDX-License-Identifier: AGPL-3.0-only
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { centredOver, localBarColors } from './chrome.js';

/** What a dialog says and offers, as Electron's message boxes do. */
export interface DialogOptions {
  /** info, question or warning: the mark beside the message. */
  type?: 'info' | 'question' | 'warning';
  message: string;
  detail?: string;
  buttons: string[];
  /** The button Enter presses and that has the focus at first. */
  defaultId?: number;
  /** The answer when the dialog is closed or Escape is pressed. */
  cancelId?: number;
}

const WIDTH = 440;

interface Pending {
  options: DialogOptions;
  answer: (response: number) => void;
  window: BrowserWindow;
  parent: BrowserWindow | null;
}
const open = new Map<number, Pending>();

let page: { origin: string; preload: string; lang: () => string } | null = null;

/**
 * The app's dialogs in its own look (Geist, the app's colors, light or dark)
 * instead of the system's message boxes: a small window of the app's own
 * page, which the server's pages cannot reach, so it also asks for
 * permissions. setupDialogs runs once, before the first dialog.
 */
export function setupDialogs(opts: { origin: string; preload: string; lang: () => string }) {
  page = opts;
  const pending = (e: IpcMainInvokeEvent) => open.get(e.sender.id);
  ipcMain.handle('dialog:get', (e) => {
    const p = pending(e);
    return p?.options ?? null;
  });
  // The page measured itself: the window takes its height and shows.
  ipcMain.handle('dialog:ready', (e, height: unknown) => {
    const p = pending(e);
    if (!p || typeof height !== 'number' || !Number.isFinite(height)) return;
    const h = Math.max(120, Math.min(600, Math.ceil(height)));
    p.window.setContentSize(WIDTH, h);
    const [w = WIDTH, outer = h] = p.window.getSize();
    const parent = p.parent && !p.parent.isDestroyed() ? p.parent : null;
    const over = parent?.isVisible() ? parent.getBounds() : null;
    if (over) {
      const { x, y } = centredOver(over, w, outer);
      p.window.setPosition(x, y);
    } else p.window.center();
    p.window.show();
  });
  ipcMain.handle('dialog:answer', (e, response: unknown) => {
    const p = pending(e);
    if (!p || typeof response !== 'number' || !Number.isInteger(response)) return;
    if (response < 0 || response >= p.options.buttons.length) return;
    p.answer(response);
  });
}

/** Shows a dialog over a window (or on its own); resolves with the button's index. */
export function showDialog(parent: BrowserWindow | null, options: DialogOptions): Promise<number> {
  if (!page) throw new Error('setupDialogs has not run');
  const usable = parent && !parent.isDestroyed() ? parent : null;
  const win = new BrowserWindow({
    parent: usable ?? undefined,
    modal: !!usable,
    width: WIDTH,
    height: 200,
    useContentSize: true,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: !!usable,
    title: 'Cenacle',
    backgroundColor: localBarColors().color,
    webPreferences: {
      preload: page.preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const id = win.webContents.id;
  const cancel = options.cancelId ?? 0;
  return new Promise((resolve) => {
    let done = false;
    const answer = (response: number) => {
      if (done) return;
      done = true;
      open.delete(id);
      resolve(response);
      if (!win.isDestroyed()) win.close();
    };
    open.set(id, { options, answer, window: win, parent: usable });
    win.on('closed', () => answer(cancel));
    const url = new URL('/dist/pages/dialog.html', page!.origin);
    url.searchParams.set('lang', page!.lang());
    void win.loadURL(url.toString()).catch(() => answer(cancel));
  });
}
