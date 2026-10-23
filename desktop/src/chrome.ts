// SPDX-License-Identifier: AGPL-3.0-only
// The app's window chrome: no menu bar and no system title bar. Each window
// draws its own 36-pixel bar in the app's colors; the minimize, maximize
// and close buttons are the system's, drawn over it in the same colors
// (Window Controls Overlay, Windows and Linux).
import {
  BrowserWindow,
  nativeTheme,
  WebContentsView,
  type BrowserWindowConstructorOptions,
  type Session,
  type WebContents,
} from 'electron';

export const TITLE_BAR_HEIGHT = 36;

export interface BarColors {
  color: string;
  symbolColor: string;
}

/** The bar of the app's own pages: Paper (light) or Night (dark), as the pages. */
export function localBarColors(): BarColors {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#0e1714', symbolColor: '#ece8dd' }
    : { color: '#faf7f0', symbolColor: '#16201d' };
}

/** Options of a window with the app's chrome. */
export function chromeOptions(colors: BarColors): BrowserWindowConstructorOptions {
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...colors, height: TITLE_BAR_HEIGHT },
    autoHideMenuBar: true,
  };
}

/** A CSS color the pages may give for the bar: hex, rgb()/rgba() or oklch(). */
export function isBarColor(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    /^(#[0-9a-f]{3,8}|rgba?\([\d.,%\s/]+\)|oklch\([\d.%\s/-]+\))$/i.test(value.trim())
  );
}

/**
 * The shortcuts the menu bar used to carry: zoom, reload, full screen.
 * Copy, paste, undo and select-all are the page's own.
 */
export function bindShortcuts(contents: WebContents, win: BrowserWindow): void {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const key = input.key;
    if (mod && (key === '+' || key === '=')) contents.setZoomLevel(contents.getZoomLevel() + 0.5);
    else if (mod && key === '-') contents.setZoomLevel(contents.getZoomLevel() - 0.5);
    else if (mod && key === '0') contents.setZoomLevel(0);
    else if ((mod && key.toLowerCase() === 'r') || key === 'F5') contents.reload();
    else if (key === 'F11') win.setFullScreen(!win.isFullScreen());
    else return;
    event.preventDefault();
  });
}

/**
 * A window for pages that are not the app's own (Cenacle ID, the sign-in,
 * other sites): the app's bar on top, with a lock and the address of the
 * page, and the page below it in a view of its own (no bridge to the app).
 */
export function framedWindow(opts: {
  session: Session;
  width: number;
  height: number;
  parent?: BrowserWindow;
  icon: string;
  frameUrl: string;
  framePreload: string;
  /** Back and reload buttons in the bar (other sites, Cenacle ID's pages). */
  browse: boolean;
}): { win: BrowserWindow; view: WebContentsView } {
  const colors = localBarColors();
  const win = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    minWidth: 400,
    minHeight: 480,
    parent: opts.parent,
    show: false,
    icon: opts.icon,
    backgroundColor: colors.color,
    ...chromeOptions(colors),
    webPreferences: {
      preload: opts.framePreload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  const view = new WebContentsView({
    webPreferences: {
      session: opts.session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.contentView.addChildView(view);
  const layout = () => {
    const { width, height } = win.getContentBounds();
    view.setBounds({ x: 0, y: TITLE_BAR_HEIGHT, width, height: height - TITLE_BAR_HEIGHT });
  };
  layout();
  win.on('resize', layout);
  bindShortcuts(view.webContents, win);

  // The bar names the page's host, with a lock for https.
  const tellFrame = () => {
    if (win.isDestroyed()) return;
    let host = '';
    let secure = false;
    try {
      const u = new URL(view.webContents.getURL());
      host = u.host;
      secure = u.protocol === 'https:';
    } catch {
      // Nothing loaded yet.
    }
    win.webContents.send('frame:page', {
      host,
      secure,
      browse: opts.browse,
      canGoBack: view.webContents.navigationHistory.canGoBack(),
    });
    win.setTitle(host);
  };
  view.webContents.on('did-navigate', tellFrame);
  view.webContents.on('did-navigate-in-page', tellFrame);
  win.webContents.on('did-finish-load', tellFrame);
  win.on('page-title-updated', (e) => e.preventDefault());
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (!view.webContents.isDestroyed()) view.webContents.close();
  });
  void win.loadURL(opts.frameUrl);
  return { win, view };
}
