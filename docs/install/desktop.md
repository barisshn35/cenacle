# The desktop app

Cenacle has a desktop app for **Windows** (10 and 11, x64 and arm64) and **Linux** (x64 and
arm64). It opens your organisation's Cenacle server and works while the web app is turned
off. macOS follows later. Design: [ADR 0033](../adr/0033-desktop-app.md).

## Getting the files

Every release (`v*` tag) builds the app in CI and publishes it to the project's package
registry as `cenacle-desktop/<version>/`:

| File                                            | For                                                          |
| ----------------------------------------------- | ------------------------------------------------------------ |
| `Cenacle-<version>-setup.exe`                   | Windows, x64 and arm64 (installs for the current user)       |
| `Cenacle-<version>-x86_64.AppImage`, `-arm64`   | Linux, runs anywhere; updates itself                         |
| `Cenacle-<version>-amd64.deb`, `-arm64.deb`     | Debian, Ubuntu                                               |
| `Cenacle-<version>-x86_64.rpm`, `-aarch64.rpm`  | Fedora, RHEL, SUSE                                           |
| `latest.yml`, `latest-linux*.yml`, `*.blockmap` | the app's updates (checksums, sizes)                         |
| `index.json`                                    | the list the web app shows on its "Use the Cenacle app" page |

## Offering it from your server

Copy all files of a release into `deploy/compose/downloads/desktop/` (or the folder
`CENACLE_DOWNLOADS_DIR` names; with Helm, a volume claim set as `web.downloadsClaim`). They
are then served at `https://<chat-domain>/downloads/desktop/`:

- the app checks there for updates (a minute after start, then every six hours) and asks
  people before downloading and before restarting; nothing else is contacted;
- the web app's "Use the Cenacle app" page (shown when the web app is turned off) lists the
  installers.

Keep the previous release's files until everyone has updated, or simply replace them: the
update files always name the newest version. To make old apps update before they sign in,
set `CENACLE_DESKTOP_MIN_VERSION` (for example `0.30.0`) on the server.

## Installing

- **Windows:** run the setup. The packages are not signed yet, so Windows SmartScreen
  shows "Windows protected your PC": choose **More info**, then **Run anyway**. Managed
  computers can install it silently: `Cenacle-<version>-setup.exe /S`.
- **Linux:** install the deb or rpm with the package manager, or make the AppImage
  executable and run it. Keeping the session needs a keyring (GNOME Keyring or KWallet);
  without one people sign in at every start.

## First start

The app asks for the server address (what the IT department gives, for example
`chat.example.com`), checks it and opens it. Signing in happens in a window of the app at
Cenacle ID's page: username and password, then the code from the authenticator app. People
stay signed in until they sign out. Settings, **This app** shows the server and the
version, and has **Change server**, **Check for updates** and whether the app keeps running
in the tray when its window is closed.

## What it keeps on the computer

- The server address, recent servers and the window's position (`config.json`).
- The session, encrypted by the operating system (DPAPI on Windows, the keyring on Linux).
- The web app's own data (drafts, settings) in the app's profile.

Signing out removes the session; **Change server** removes everything of the server.
Profiles live in `%APPDATA%\Cenacle` (Windows) and `~/.config/Cenacle` (Linux).
