# 0033. The desktop app (v0.30)

- Status: accepted
- Date: 2026-10-23

## Context

Cenacle needs a desktop app before 1.0, and organisations that turn the web app off (ADR 0032) need it to use Cenacle at all. The app must keep to the same rules as the rest:
self-hosted (nothing contacts anyone but the organisation's server), the sign-in of ADR
0032, and no password typed into the chat app. The people who decided its shape asked for
two things beyond that: **everything happens inside the app** (no system browser, not even
for the sign-in or for links to other sites), and **no menu bar or system title bar**: the
window's bar and its buttons look like the app.

## Decisions

1. **Electron 44** (the newest line with patch releases; 45 waits for its first), with
   electron-builder and electron-updater (MIT). **Windows and Linux** first: one Windows
   installer (NSIS) for x64 and arm64, and AppImage, deb and rpm for x64 and arm64. macOS
   waits for a Mac build machine and an Apple account; the code keeps to portable APIs.
   The packages are **unsigned** until the organisation has certificates; the install guide
   says how to accept them.
2. **The app shows the server's web app.** It pairs once with one server (its address,
   checked at `/api/meta`) and opens it, so the interface always matches the server. The app
   adds only what a browser lacks: a bridge with a few named actions (`signIn`, `signOut`,
   `changeServer`, `setBadge`, `setTitleBar`, `prefs`, `setCloseToTray`, `checkUpdates`),
   offered to the server's top-level pages only.
3. **Sign-in inside the app, still at Cenacle ID.** The app opens
   `/api/auth/login?desktop=<S256 challenge>` in a window of its own: an in-memory session
   that is cleared afterwards, no bridge, the page's address with a lock in the window's
   bar. The chat server runs the usual OIDC sign-in, then — instead of setting a cookie —
   keeps the new session under a one-time code (one minute) and ends at
   `/desktop/signed-in?code=…`, where the window stops. The app exchanges the code with the
   verifier at `POST /api/auth/desktop/token`. The chat app never sees a password; the code
   alone is useless to anyone who saw it. This replaces the system browser and loopback
   redirect of RFC 8252, which was written for third-party apps: here app, server and
   identity provider belong to the same organisation. Desktop sign-ins work while the web
   app is off.
4. **The session token never reaches a page.** It is kept encrypted by the operating
   system (`safeStorage`: DPAPI, the keyring) and added to the server's requests by the app
   (`Authorization: Bearer`). Without an encrypted store (Linux without a keyring) it lives
   in memory only and the app says so. Signing out ends the session on the server too.
5. **Everything inside the app.** Cenacle ID's account pages open in an app window with a
   persistent session of their own; links to other sites each in an isolated window
   (in-memory session, no device permissions, nothing kept); files through the save
   dialog; updates from the paired server. Only `mailto:` goes to the mail program.
6. **Hardening.** Sandboxed renderers, context isolation, no Node in pages, navigation and
   pop-ups confined (the server's window stays on the server), no device permissions
   except notifications for the server, Electron fuses (no running as Node, no
   `NODE_OPTIONS` or inspector flags, the code only from its integrity-checked archive,
   no extra rights for `file://`). The app's own pages come through its own scheme,
   `cenacle-app://`, limited to their folder, with a strict CSP.
7. **The window's chrome.** No menu bar: its actions are in Settings, This app, and the
   tray; zoom, reload and full screen keep their shortcuts. Each window draws a 36-pixel
   bar; the system's minimize, maximize and close buttons are drawn over it in the bar's
   colors (Window Controls Overlay), which the page gives as the theme changes. Windows
   for others' pages show a lock, the address, back and reload in that bar, with the page
   in a view below it.
8. **Updates from the organisation's server.** Administrators put a release's files
   (installers, `latest.yml`, `latest-linux.yml`, `index.json`) in the server's
   `downloads/desktop/`; the app checks there only, a minute after start and every six hours,
   asks before downloading and before restarting. `CENACLE_DESKTOP_MIN_VERSION` makes
   older apps update before signing in. The web app lists the installers on its "Use the
   Cenacle app" page.
   Since 0.99.3 the app installs only updates signed with the release key built into it;
   the server only hosts them ([ADR 0048](0048-audit-fixes-0993.md)).
9. **Dependencies.** Two permissive licenses outside the usual list, each checked by hand
   and allowed by name in `scripts/check-licenses.mjs`: `argparse` (PSF, through the
   updater's YAML reader) and, for packaging only, `truncate-utf8-bytes` (WTFPL).

## Consequences

- The CI image carries GTK and Xvfb; the desktop app's tests run against a stand-in server
  and against the whole stack (with a soak run). Packaging runs on `v*` tags in
  electron-builder's image and publishes to the package registry and, since 1.0, to the
  release on GitHub Releases (`docs/operations/ci.md`).
- Unsigned packages warn on Windows (SmartScreen) until a certificate is set up.
- A server that turns the web app off still serves the web app's files: the desktop app
  shows them.
- Spell checking (after 0.99.4): Electron downloaded each language's dictionary from Google
  the first time it checked a word, against "nothing contacts anyone but the organisation's
  server". The dictionaries now come with the app (`desktop/dictionaries`: English, SCOWL's
  permissive notice; Turkish, hunspell-tr under MPL-2.0 with its source in
  `desktop/dictionaries/source/`; both notices in the third-party notices) and the download
  address is a closed local port (`desktop/src/spellcheck.ts`). Chromium's own Turkish
  dictionary (tr-spell) was not taken: its project page says Apache-2.0, Chromium's README
  lists GPL, LGPL and MPL 1.1. The first preferred language decides what is checked; a
  language without a dictionary is not checked rather than checked as English.
