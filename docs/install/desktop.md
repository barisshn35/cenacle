# The desktop app

Cenacle has a desktop app for **Windows** (10 and 11, x64 and arm64) and **Linux** (x64 and
arm64). It opens your organisation's Cenacle server and works while the web app is turned
off. macOS follows later. Design: [ADR 0033](../adr/0033-desktop-app.md).

## Getting the files

From 1.0.0 on, every release (`v*` tag) builds the app in CI and publishes it on
[GitHub Releases](https://github.com/Cenacle-TR/cenacle/releases), on the page of the
release (`v<version>`), together with the SBOMs of the images:

| File                                            | For                                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| `Cenacle-<version>-setup.exe`                   | Windows, x64 and arm64 (installs for the current user)                        |
| `Cenacle-<version>-x64.msi`                     | Windows x64 for organizations: all users, silent, no updates                  |
| `Cenacle-<version>-x64.msix`, `-arm64.msix`     | the Microsoft Store ([how they are published](../desktop/microsoft-store.md)) |
| `Cenacle-<version>-policy-templates.zip`        | Group Policy templates (ADMX, English and Turkish)                            |
| `Cenacle-<version>-x86_64.AppImage`, `-arm64`   | Linux, runs anywhere; updates itself                                          |
| `Cenacle-<version>-amd64.deb`, `-arm64.deb`     | Debian, Ubuntu                                                                |
| `Cenacle-<version>-x86_64.rpm`, `-aarch64.rpm`  | Fedora, RHEL, SUSE                                                            |
| `latest.yml`, `latest-linux*.yml`, `*.blockmap` | the app's updates (checksums, sizes)                                          |
| `latest.yml.sig`, `latest-linux*.yml.sig`       | the update files' signatures: the app installs no update without them         |
| `SHA256SUMS`, `SHA256SUMS.sigstore.json`        | checksums of the files above, and their signature                             |
| `SHA256SUMS.asc`, `cenacle-linux.asc`           | the checksums signed with GPG, and the key (also of the rpms)                 |
| `index.json`                                    | the list the web app shows on its "Use the Cenacle app" page                  |

The signature shows the files come from the project's release
(`docs/security/README.md`, Verifying a release). A release page appears once all of its
files are uploaded and the checksums are signed.

## Offering it from your server

Download all files of a release, check them, then copy them into
`deploy/compose/downloads/desktop/` (or the folder `CENACLE_DOWNLOADS_DIR` names; with Helm,
a volume claim set as `web.downloadsClaim`). With the GitHub CLI and cosign, from the
directory of your Cenacle checkout (for `deploy/cosign.pub`):

```sh
v=1.0.0
mkdir "desktop-$v" && cd "desktop-$v"
gh release download "v$v" --repo Cenacle-TR/cenacle --pattern '*' --skip-existing
cosign verify-blob --key ../deploy/cosign.pub --insecure-ignore-tlog \
  --bundle SHA256SUMS.sigstore.json SHA256SUMS
sha256sum --check SHA256SUMS
rm -f *.spdx.json install.sh cenacle-compose-*.tar.gz   # the images' SBOMs and the server installation, not needed here
cp ./* ../deploy/compose/downloads/desktop/
```

Without the GitHub CLI, download the files from the release page in a browser. Replace the
previous release's files rather than adding to them: `index.json` and the `latest*.yml`
files name the current installers only. The files are then served at
`https://<chat-domain>/downloads/desktop/`:

- the app checks there for updates (a minute after start, then every six hours) and asks
  people before downloading and before restarting. It takes an
  update only when the update file is signed with the release key built into the app (the
  `.sig` files), so a server can offer the project's releases but not installers of its
  own. Apps from the Microsoft Store and from the MSI do not look: the Store or the
  organization updates them;
- the web app's "Use the Cenacle app" page (shown when the web app is turned off) lists the
  installers.

The app contacts the paired server only. Spell checking uses dictionaries that come with the
app, in every package (setup, MSI, MSIX, AppImage, deb, rpm; `resources/dictionaries` of the
installation), and downloads none, with or without internet access: the address Electron
would fetch a missing dictionary from is a closed port on the computer itself. The app comes
with English and Turkish. The first of the operating system's preferred languages decides:
when it is English or Turkish, that language is checked, together with the other of the two
when it is preferred too; when it is any other language (German, for example), nothing is
checked, rather than marking every word of it. Without any preferred language it checks
English. It underlines misspelled words without suggesting others and has no setting. A dictionary an
older version downloaded into the `Dictionaries` folder of the app's data folder (below) stays
there and is used. Up to 0.99.4 the app downloaded each language's dictionary from Google
(`redirector.gvt1.com`) the first time it checked a word.

To check an update file's signature by hand (OpenSSL 3.0 or later), take the public key from
`desktop/src/update-keys.ts`, then:

```sh
F=latest.yml   # latest.yml.sig lies next to it
sed -n '/-----BEGIN PUBLIC KEY-----/,/-----END PUBLIC KEY-----/p' desktop/src/update-keys.ts \
  | tr -d '`' | sed 's/^ *//;s/,$//' > update-key.pem
{ printf 'cenacle-update-v1\n%s\n' "$(basename "$F")"; cat "$F"; } > msg.bin
base64 -d "$F.sig" > sig.bin
openssl pkeyutl -verify -pubin -inkey update-key.pem -rawin -in msg.bin -sigfile sig.bin
```

It prints `Signature Verified Successfully`. The file name is part of what is signed, so a
renamed file fails too.

Keep the previous release's files until everyone has updated, or simply replace them: the
update files always name the newest version. To make old apps update before they sign in,
set `CENACLE_DESKTOP_MIN_VERSION` (for example `0.30.0`) on the server.

## Installing

- **Windows:** Cenacle is not in the Microsoft Store yet ([how it will be
  published](../desktop/microsoft-store.md)); once it is, the Store package is the one
  Windows shows no warning for, because Microsoft signs it. The setup and the MSI are not
  signed (their checksums are: `SHA256SUMS` above), so Windows SmartScreen shows "Windows
  protected your PC": choose **More info**, then **Run anyway**.
- **Managed computers:** deploy the MSI silently (`msiexec /i Cenacle-<version>-x64.msi /qn`)
  and set the server with Group Policy or Intune. Organizations can sign the app with their
  own certificate. See [enterprise deployment](../desktop/enterprise-deployment.md) for what
  Windows checks on managed computers.
- **Linux:** install the deb or rpm with the package manager, or make the AppImage
  executable and run it (AppImages need FUSE 2: `libfuse2t64` on Ubuntu 24.04, `libfuse2`
  on older Debian and Ubuntu, `fuse-libs` on Fedora). Keeping the session needs a keyring
  (GNOME Keyring or KWallet); without one people sign in at every start. Organizations set
  the server in `/etc/cenacle/desktop-policy.json`
  ([enterprise deployment](../desktop/enterprise-deployment.md)).

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
The app's data folder is `%APPDATA%\Cenacle` on Windows (setup and MSI) and
`~/.config/Cenacle` on Linux; uninstalling with the setup removes it (an update does not),
so a reinstalled app asks to sign in again. Versions before 0.99.6 kept it in
`@cenacle\desktop` (`@cenacle/desktop` on Linux): the app moves it once when it starts. On
Linux the keyring entry of the session follows the app's name, so after that move people
sign in once more. Windows keeps the MSIX package's data apart, in
`%LOCALAPPDATA%\Packages\Cenacle.Desktop_<publisher ID>\LocalCache\Roaming\Cenacle`;
the publisher ID follows from the package's publisher (`nqp2b3c5ery4j` for `CN=Cenacle`, the
publisher of the packages built without `MSIX_PUBLISHER`; a Store package has the one of its
Store account).
