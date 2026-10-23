// SPDX-License-Identifier: AGPL-3.0-only
import {
  app,
  BrowserWindow,
  protocol,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents,
} from 'electron';
import { join, normalize as normalizePath, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fill, language, setupLanguage, t } from './i18n.js';
import { hardenSession, originOf } from './security.js';
import { check, normalize, type PairError } from './server.js';
import { signIn } from './signin.js';
import {
  canKeepSession,
  clearToken,
  loadConfig,
  loadToken,
  remember,
  saveConfig,
  saveToken,
  type Config,
} from './store.js';
import { checkForUpdates, setupUpdates } from './updater.js';

/** The persistent session of the server's pages: its storage, drafts and cache. */
const APP_PARTITION = 'persist:cenacle';
/** Cenacle ID's own pages (account, administration): their sign-in lasts. */
const ID_PARTITION = 'persist:cenacle-id';

const root = join(__dirname, '..');
const assets = join(root, 'assets');

/**
 * The app's own pages (pairing, offline) come from its archive through a
 * scheme of its own: file:// has no extra rights in this app (Electron fuse
 * GrantFileProtocolExtraPrivileges is off).
 */
const LOCAL_SCHEME = 'cenacle-app';
const LOCAL_ORIGIN = `${LOCAL_SCHEME}://local`;
protocol.registerSchemesAsPrivileged([
  { scheme: LOCAL_SCHEME, privileges: { standard: true, secure: true } },
]);

let config: Config;
let main: BrowserWindow | null = null;
let local: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let signingIn = false;
let externalCount = 0;
let toldNotKept = !!process.env.CENACLE_DESKTOP_DATA;

// Tests (and people with several profiles) keep the app's data elsewhere.
if (process.env.CENACLE_DESKTOP_DATA) app.setPath('userData', process.env.CENACLE_DESKTOP_DATA);

// The server sees which app it talks to (the devices list names it).
app.userAgentFallback = `${app.userAgentFallback} CenacleDesktop/${app.getVersion()}`;
app.setAppUserModelId('org.cenacle.desktop');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const link = argv.find((a) => a.startsWith('cenacle://'));
    if (link) openDeepLink(link);
    showMain();
  });
  void app.whenReady().then(start);
}

app.setAsDefaultProtocolClient('cenacle');

// Nothing runs in this app that the app did not load itself.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

app.on('before-quit', () => {
  quitting = true;
});
app.on('window-all-closed', () => {
  if (!config?.closeToTray || !tray) app.quit();
});

function serveLocalPages() {
  protocol.handle(LOCAL_SCHEME, (request) => {
    const url = new URL(request.url);
    // Only the pages and their assets; nothing outside the app's own files.
    const path = normalizePath(join(root, decodeURIComponent(url.pathname)));
    const allowed = [join(root, 'dist', 'pages') + sep, join(root, 'assets') + sep];
    if (url.host !== 'local' || !allowed.some((dir) => path.startsWith(dir)))
      return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path).toString());
  });
}

async function start() {
  setupLanguage();
  serveLocalPages();
  config = loadConfig();
  createTray();
  buildMenu();
  registerIpc();
  if (config.server) openServer(config.server);
  else showPairing();
  setupUpdates(
    () => config.server,
    () => main ?? local,
  );
  const link = process.argv.find((a) => a.startsWith('cenacle://'));
  if (link) openDeepLink(link);
}

// --- the server's window ------------------------------------------------------

function appSession(server: string): Session {
  const ses = session.fromPartition(APP_PARTITION);
  hardenSession(ses, { allowNotifications: true });
  // The session token goes along with every request to the server, added
  // here: the pages never see it, so a script in them cannot take it.
  ses.webRequest.onBeforeSendHeaders({ urls: [`${server}/*`] }, (details, callback) => {
    const token = loadToken();
    const headers = { ...details.requestHeaders };
    if (token) headers.Authorization = `Bearer ${token}`;
    callback({ requestHeaders: headers });
  });
  return ses;
}

function openServer(server: string, path = '/') {
  config = remember({ ...config, server }, server);
  saveConfig(config);
  local?.destroy();
  local = null;
  if (!main) main = createMainWindow(server);
  void main.loadURL(new URL(path, server).toString());
  if (!loadToken()) void startSignIn('/');
}

function createMainWindow(server: string): BrowserWindow {
  const b = config.bounds;
  const win = new BrowserWindow({
    width: b?.width ?? 1280,
    height: b?.height ?? 820,
    x: b?.x,
    y: b?.y,
    minWidth: 400,
    minHeight: 480,
    show: false,
    title: t().appName,
    icon: join(assets, 'icon.png'),
    backgroundColor: '#14342b',
    webPreferences: {
      session: appSession(server),
      preload: join(__dirname, 'preload.js'),
      additionalArguments: [`--cenacle-version=${app.getVersion()}`],
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
    },
  });
  if (b?.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  guardNavigation(win.webContents, server);
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    // -3 is an aborted load (a navigation replaced it), not an outage.
    if (isMainFrame && code !== -3 && originOf(url) === server) showOffline(server, url);
  });
  win.on('close', (e) => {
    const bounds = win.getNormalBounds();
    config = { ...config, bounds: { ...bounds, maximized: win.isMaximized() } };
    saveConfig(config);
    if (!quitting && config.closeToTray && tray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    if (main === win) main = null;
  });
  return win;
}

/**
 * Keeps the server's window on the server. Its own pages stay; files are
 * saved; Cenacle ID's pages and other web sites open in windows of their
 * own inside the app; e-mail addresses go to the mail program.
 */
function guardNavigation(contents: WebContents, server: string) {
  contents.on('will-navigate', (event, url) => {
    if (originOf(url) === server) return;
    event.preventDefault();
    openLink(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (originOf(url) === server) {
      const path = new URL(url).pathname;
      if (path.startsWith('/api/')) contents.downloadURL(url);
      else void contents.loadURL(url);
      return { action: 'deny' };
    }
    openLink(url);
    return { action: 'deny' };
  });
}

function openLink(url: string) {
  if (url.startsWith('mailto:')) {
    void shell.openExternal(url);
    return;
  }
  const origin = originOf(url);
  if (!origin) return;
  if (origin === config.idp) openIdentityWindow(url);
  else openExternalWindow(url);
}

/** Cenacle ID's account and administration pages, in a window of their own. */
function openIdentityWindow(url: string) {
  const ses = session.fromPartition(ID_PARTITION);
  hardenSession(ses, { allowNotifications: false });
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: new URL(url).host,
    icon: join(assets, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  keepTitleOnHost(win);
  const idp = originOf(url)!;
  win.webContents.on('will-navigate', (event, target) => {
    const origin = originOf(target);
    // Back to the chat server ("Back to Cenacle"): show it in the main window.
    if (origin === config.server) {
      event.preventDefault();
      showMain();
      win.close();
    } else if (origin !== idp) {
      event.preventDefault();
      openLink(target);
    }
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    openLink(target);
    return { action: 'deny' };
  });
  void win.loadURL(url);
}

/**
 * Other web sites (links in messages), each in its own window with its own
 * in-memory session: no access to Cenacle's session, nothing kept, no
 * camera, microphone or location.
 */
function openExternalWindow(url: string) {
  const ses = session.fromPartition(`cenacle-external-${++externalCount}`);
  hardenSession(ses, { allowNotifications: false });
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: new URL(url).host,
    icon: join(assets, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  keepTitleOnHost(win);
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (originOf(target)) void win.loadURL(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (!originOf(target)) event.preventDefault();
  });
  win.on('closed', () => {
    void ses.clearStorageData();
  });
  void win.loadURL(url);
}

/** The title of a window shows the address of its page, so people see where they are. */
function keepTitleOnHost(win: BrowserWindow) {
  win.on('page-title-updated', (e) => e.preventDefault());
  win.webContents.on('did-navigate', (_e, url) => {
    const u = new URL(url);
    if (!win.isDestroyed()) win.setTitle(`${u.protocol === 'https:' ? '🔒 ' : ''}${u.host}`);
  });
}

async function startSignIn(returnTo: string) {
  const server = config.server;
  if (!server || signingIn) return;
  signingIn = true;
  try {
    const result = await signIn({
      server,
      parent: main,
      returnTo,
      onIdentityProvider: (origin) => {
        if (config.idp !== origin) {
          config = { ...config, idp: origin };
          saveConfig(config);
        }
      },
    });
    if ('token' in result) {
      saveToken(result.token);
      if (!canKeepSession() && main && !toldNotKept) {
        toldNotKept = true;
        void dialog.showMessageBox(main, { type: 'info', message: t().signIn.notKept });
      }
      void main?.loadURL(new URL(returnTo, server).toString());
      return;
    }
    if (result.error === 'closed') return;
    const opts = {
      type: 'warning' as const,
      message: t().signIn.failedTitle,
      detail: t().signIn.failed[result.error],
      buttons: [t().signIn.retry, t().signIn.close],
      defaultId: 0,
      cancelId: 1,
    };
    const { response } = await (main
      ? dialog.showMessageBox(main, opts)
      : dialog.showMessageBox(opts));
    signingIn = false;
    if (response === 0) void startSignIn(returnTo);
  } finally {
    signingIn = false;
  }
}

async function signOut() {
  const server = config.server;
  const token = loadToken();
  if (server && token) {
    // Ends the session on the server; the app forgets it either way.
    await net
      .fetch(`${server}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      })
      .catch(() => undefined);
  }
  clearToken();
  await session.fromPartition(ID_PARTITION).clearStorageData();
  app.setBadgeCount(0);
  main?.setOverlayIcon(null, '');
  if (server) void main?.loadURL(new URL('/signin', server).toString());
}

async function changeServer() {
  await signOut();
  await session.fromPartition(APP_PARTITION).clearStorageData();
  config = { ...config, server: null, idp: null };
  saveConfig(config);
  main?.destroy();
  main = null;
  showPairing();
}

function showMain() {
  const win = main ?? local;
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function openDeepLink(link: string) {
  // cenacle://open/c/<channel> opens that place of the paired server.
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return;
  }
  if (url.protocol !== 'cenacle:' || url.host !== 'open' || !config?.server) return;
  const path = url.pathname.startsWith('/') ? url.pathname : '/';
  if (main) void main.loadURL(new URL(path + url.search, config.server).toString());
  showMain();
}

// --- the app's own pages: pairing and offline ----------------------------------

function localWindow(page: 'pair' | 'offline', query: Record<string, string>) {
  if (!local) {
    local = new BrowserWindow({
      width: 980,
      height: 700,
      minWidth: 400,
      minHeight: 480,
      show: false,
      title: t().appName,
      icon: join(assets, 'icon.png'),
      backgroundColor: '#faf7f0',
      webPreferences: {
        preload: join(__dirname, 'local-preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    local.once('ready-to-show', () => local?.show());
    local.webContents.on('will-navigate', (e) => e.preventDefault());
    local.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    local.on('closed', () => {
      local = null;
    });
  }
  const url = new URL(`/dist/pages/${page}.html`, LOCAL_ORIGIN);
  for (const [k, v] of Object.entries({ ...query, lang: language() })) url.searchParams.set(k, v);
  void local.loadURL(url.toString());
  return local;
}

function showPairing() {
  localWindow('pair', {});
}

let offlineTimer: NodeJS.Timeout | null = null;
function showOffline(server: string, url: string) {
  main?.hide();
  localWindow('offline', { host: new URL(server).host });
  if (offlineTimer) clearInterval(offlineTimer);
  // Tries again every 15 seconds until the server answers.
  offlineTimer = setInterval(() => {
    void check(server).then((r) => {
      if ('meta' in r) retryOnline(url);
    });
  }, 15_000);
}

function retryOnline(url?: string) {
  if (offlineTimer) clearInterval(offlineTimer);
  offlineTimer = null;
  local?.destroy();
  local = null;
  if (main && config.server) {
    void main.loadURL(url ?? config.server);
    main.show();
  }
}

// --- IPC: what the pages may ask of the app -----------------------------------

/** Only the paired server's top-level pages talk to the app. */
function fromServer(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? '';
  return !!config.server && e.senderFrame === e.sender.mainFrame && originOf(url) === config.server;
}

/** Only the app's own pages (loaded from its files). */
function fromLocal(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? '';
  return url.startsWith(`${LOCAL_ORIGIN}/`) && e.sender === local?.webContents;
}

function registerIpc() {
  ipcMain.handle('desktop:sign-in', (e, returnTo: unknown) => {
    if (!fromServer(e)) return;
    const path =
      typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//')
        ? returnTo
        : '/';
    void startSignIn(path);
  });
  ipcMain.handle('desktop:sign-out', async (e) => {
    if (fromServer(e)) await signOut();
  });
  ipcMain.handle('desktop:change-server', async (e) => {
    if (fromServer(e) || fromLocal(e)) await changeServer();
  });
  ipcMain.handle('desktop:badge', (e, count: unknown) => {
    if (!fromServer(e) || typeof count !== 'number' || !Number.isFinite(count)) return;
    setBadge(Math.max(0, Math.min(9999, Math.floor(count))));
  });
  ipcMain.handle('desktop:server', (e) => (fromServer(e) || fromLocal(e) ? config.server : null));

  ipcMain.handle('pair:texts', (e) =>
    fromLocal(e) ? { ...t().pair, offline: t().offline } : null,
  );
  ipcMain.handle('pair:recent', (e) => (fromLocal(e) ? config.recent : []));
  ipcMain.handle('pair:forget', (e, origin: unknown) => {
    if (!fromLocal(e) || typeof origin !== 'string') return config.recent;
    config = { ...config, recent: config.recent.filter((r) => r.origin !== origin) };
    saveConfig(config);
    return config.recent;
  });
  ipcMain.handle(
    'pair:connect',
    async (e, address: unknown): Promise<{ ok: true } | { error: PairError; version?: string }> => {
      if (!fromLocal(e) || typeof address !== 'string') return { error: 'invalid' };
      const n = normalize(address);
      if ('error' in n) return n;
      const r = await check(n.origin);
      if ('error' in r) return r;
      openServer(n.origin);
      return { ok: true };
    },
  );
  ipcMain.handle('offline:retry', (e) => {
    if (fromLocal(e)) retryOnline();
  });
}

// --- tray, badge and menu ------------------------------------------------------

function createTray() {
  if (process.platform !== 'win32' && process.platform !== 'linux') return;
  tray = new Tray(nativeImage.createFromPath(join(assets, 'tray.png')));
  tray.setToolTip(t().appName);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t().menu.show, click: showMain },
      { type: 'separator' },
      { label: t().menu.quit, click: () => app.quit() },
    ]),
  );
  tray.on('click', showMain);
}

const badgeIcon = () => nativeImage.createFromPath(join(assets, 'badge.png'));

function setBadge(count: number) {
  app.setBadgeCount(count);
  // Windows has no count on the taskbar button: a dot over the icon says it.
  if (process.platform === 'win32')
    main?.setOverlayIcon(count > 0 ? badgeIcon() : null, count > 0 ? String(count) : '');
  tray?.setToolTip(count > 0 ? `${t().appName} (${count})` : t().appName);
}

function buildMenu() {
  const m = t().menu;
  const template: MenuItemConstructorOptions[] = [
    {
      label: m.file,
      submenu: [
        { label: m.changeServer, click: () => void changeServer() },
        { label: m.signOut, click: () => void signOut() },
        { type: 'separator' },
        {
          label: m.closeToTray,
          type: 'checkbox',
          checked: loadConfig().closeToTray,
          click: (item) => {
            config = { ...config, closeToTray: item.checked };
            saveConfig(config);
          },
        },
        { type: 'separator' },
        { label: m.quit, accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: m.edit,
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
      ],
    },
    {
      label: m.view,
      submenu: [
        { label: m.reload, role: 'reload' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as MenuItemConstructorOptions]),
        { type: 'separator' },
        { label: m.actualSize, role: 'resetZoom' },
        { label: m.zoomIn, role: 'zoomIn' },
        { label: m.zoomOut, role: 'zoomOut' },
        { type: 'separator' },
        { label: m.fullScreen, role: 'togglefullscreen' },
      ],
    },
    { label: m.window, submenu: [{ role: 'minimize' }, { role: 'close' }] },
    {
      label: m.help,
      submenu: [
        { label: m.checkUpdates, click: () => void checkForUpdates(true) },
        {
          label: m.about,
          click: () =>
            void dialog.showMessageBox({
              type: 'info',
              message: `${t().appName} ${app.getVersion()}`,
              detail: `${config.server ?? ''}\nElectron ${process.versions.electron}`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export const forTests = { normalize, fill };
