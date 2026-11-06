# Deploying the desktop app in an organization

This guide is for IT departments that install Cenacle on managed computers: which package to
use, how to install it silently, how to set the server for everyone, and how to sign the app
with the organization's own certificate so that it installs without warnings and passes
application control (AppLocker, WDAC).

## Which package

| Package                                | Installs                           | Updates                                     |
| -------------------------------------- | ---------------------------------- | ------------------------------------------- |
| `Cenacle-<version>-x64.msi`            | for all users, `Program Files`     | by the organization (the app never updates) |
| `Cenacle-<version>-setup.exe`          | for the person installing it       | the app, from the paired server             |
| `Cenacle-<version>-x64.msix`, `-arm64` | per user (Microsoft Store, Intune) | the Microsoft Store, or the organization    |
| `.deb`, `.rpm`                         | for all users                      | the package manager (your repository)       |

For managed Windows computers, use the MSI. It replaces any older Cenacle MSI when a newer one
is installed (the product's upgrade code never changes).

## Installing silently

```bat
msiexec /i Cenacle-0.99.0-x64.msi /qn /l*v cenacle-install.log
```

Uninstall with `msiexec /x Cenacle-0.99.0-x64.msi /qn`. With Intune, add the MSI as a
**line-of-business app**; with Configuration Manager, as an application with the MSI's product
code (detection). The MSI creates a Start menu and a desktop shortcut and registers
`cenacle://` links.

On Linux, install the deb or rpm with your configuration management (Ansible, Puppet, Salt).

## Setting the server for everyone

The app reads these settings at start. A setting for the computer wins over the same setting
for the user.

| Setting          | Registry value (`REG_SZ` / `REG_DWORD`) | Meaning                                                                |
| ---------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| Server           | `Server`, e.g. `chat.example.com`       | the app pairs with it at its first start, without asking               |
| Lock the server  | `LockServer` = `1`                      | Change server is hidden; with Server set, any other server is replaced |
| Turn off updates | `DisableUpdates` = `1`                  | the app does not look for updates (the MSI never does)                 |

Keys: `HKLM\SOFTWARE\Policies\Cenacle\Desktop` (computer) and
`HKCU\SOFTWARE\Policies\Cenacle\Desktop` (user).

**Group Policy:** unzip `Cenacle-<version>-policy-templates.zip` into the central store
(`\\<domain>\SYSVOL\<domain>\Policies\PolicyDefinitions`): `Cenacle.admx` at the top,
`en-US\Cenacle.adml` and `tr-TR\Cenacle.adml` in the language folders. The settings appear
under Computer (and User) Configuration → Administrative Templates → Cenacle.

**Intune:** import the ADMX under Devices → Configuration → Import ADMX, then create a profile
from it; or deploy the registry values with a PowerShell script:

```powershell
$key = 'HKLM:\SOFTWARE\Policies\Cenacle\Desktop'
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name Server -Value 'chat.example.com'
Set-ItemProperty -Path $key -Name LockServer -Value 1 -Type DWord
```

**Linux:** write `/etc/cenacle/desktop-policy.json`:

```json
{ "server": "chat.example.com", "lockServer": true, "disableUpdates": true }
```

## Unsigned packages on managed computers

What Microsoft documents ([SmartScreen reputation](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation),
[testing with Smart App Control](https://learn.microsoft.com/windows/apps/develop/smart-app-control/test-your-app-with-smart-app-control)):

- An unsigned file a person downloads and runs gets the "Windows protected your PC"
  warning; an organization's policy can take away **Run anyway**. Files an organization
  distributes from locations its Trusted Intranet settings cover are not reviewed by
  SmartScreen, and administrators can submit a file to Microsoft's Security Intelligence
  portal for review.
- On Windows 11, Smart App Control, where it is on, blocks unsigned programs without a
  good reputation, also ones not downloaded from the internet. `citool.exe -lp` shows
  whether it is on.
- Packages from the Microsoft Store are signed by Microsoft and get no warning.

Whether a silent MSI deployment by Intune or Configuration Manager shows the SmartScreen
warning is not stated there; try it on one computer before rolling out, or sign the app
(below) or use the Store package.

## Signing with your own certificate

Cenacle's own Windows packages are not signed with a code-signing certificate (the Microsoft
Store signs its packages itself). Organizations that require signed software sign the app with
their own certificate, usually from their internal certificate authority, which their
computers already trust. Sign the program and its libraries, not only the installer:
application control checks `Cenacle.exe` and its DLLs when the app starts.

### The MSI, built with your certificate

Build the release from its source, with your certificate given to electron-builder (on Linux
it signs with `osslsigncode`, on Windows with `signtool`):

```sh
git clone --branch v0.99.0 https://github.com/Cenacle-TR/cenacle && cd cenacle
npm install -g pnpm && pnpm install --frozen-lockfile
pnpm --filter @cenacle/desktop build
cd desktop
export CSC_LINK=/secure/codesign.pfx CSC_KEY_PASSWORD='…'
./node_modules/.bin/electron-builder --config electron-builder.signed.yml --win --x64 --publish never
node scripts/msi.mjs          # needs wixl (apt install wixl)
osslsigncode sign -pkcs12 "$CSC_LINK" -pass "$CSC_KEY_PASSWORD" -h sha256 \
  -t http://timestamp.example.com -in release/Cenacle-0.99.0-x64.msi \
  -out release/Cenacle-0.99.0-x64-signed.msi
```

On Windows, sign the MSI with
`signtool sign /fd SHA256 /tr <your timestamp server> /td SHA256 /f codesign.pfx /p … Cenacle-0.99.0-x64.msi`.
With a key in a hardware module (HSM) use its signing tool or `osslsigncode`'s PKCS#11 options
instead of a `.pfx` file.

### The MSIX, for sideloading with Intune

An MSIX package carries one signature over all its files, and its publisher must match the
certificate's subject. Build it with your certificate's subject as publisher and sign it:

```sh
export MSIX_PUBLISHER='CN=Example Ltd, O=Example Ltd, C=TR'
MAKEMSIX="$(sh scripts/makemsix.sh)" node scripts/msix.mjs
```

then on Windows `signtool sign /fd SHA256 /a /f codesign.pfx /p … Cenacle-0.99.0-x64.msix`.
Deploy the certificate to the computers' Trusted People store (an Intune certificate profile)
and the package as a line-of-business app.

## What to tell people

Their IT department set the server: they sign in with their usual account. With
`LockServer`, Settings → This app says that the organization set the server.
