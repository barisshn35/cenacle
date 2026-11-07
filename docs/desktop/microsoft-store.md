# Publishing to the Microsoft Store

The Windows app is meant for the Microsoft Store as MSIX packages; it is not published there
yet (the steps below have not been done). The Store signs them
with Microsoft's certificate when it publishes them, so people get the app without a
SmartScreen warning and the project needs no code-signing certificate. The Store updates the
app; Store installations do not use the server's update files.

## Once: the Partner Center account

1. Create a developer account in [Partner Center](https://partner.microsoft.com/dashboard)
   (individual or company; the account's name is shown as the publisher).
2. Apps and games → New product → MSIX or PWA app, and reserve the name **Cenacle**.
3. Product identity (Product management → Product identity) gives three values. Set them as
   CI/CD variables of the project (they are not secret):

   | Variable                      | Partner Center value                    | Example                |
   | ----------------------------- | --------------------------------------- | ---------------------- |
   | `MSIX_IDENTITY_NAME`          | Package/Identity/Name                   | `12345Example.Cenacle` |
   | `MSIX_PUBLISHER`              | Package/Identity/Publisher              | `CN=1A2B3C4D-…`        |
   | `MSIX_PUBLISHER_DISPLAY_NAME` | Package/Properties/PublisherDisplayName | `Example Ltd`          |

   A release's CI job stops without them; a local build uses placeholder values, which the
   Store refuses.

## Each release

1. The release's CI job builds `Cenacle-<version>-x64.msix` and `Cenacle-<version>-arm64.msix`
   into `cenacle-desktop/<version>/` of the package registry and the release's page on
   GitHub Releases. Download both.
2. In Partner Center, start a submission and upload both packages under **Packages**.
3. **Store listings** (English and Turkish): the description, at least one screenshot per
   language, and the privacy policy address (the website's privacy page).
4. **Properties:** category Business → Collaboration; the app needs internet access.
5. The packages ask for the restricted capability `runFullTrust` (all desktop apps packaged as
   MSIX do). Explain it in **Submission options → Restricted capabilities**:

   > Cenacle is a desktop app built with Electron and packaged as MSIX. runFullTrust lets it run
   > as a regular desktop process; it connects to the chat server the person or their
   > organization chooses, and to nothing else.

6. **Age ratings:** fill in the questionnaire (a communication app where people exchange
   messages).
7. Submit. Certification usually takes a few days; the Store then signs and publishes the
   packages.

## Testing a package before submitting

Windows 11 installs an unsigned MSIX for testing when its publisher carries Microsoft's
"unsigned" marker. Build one with `MSIX_ALLOW_UNSIGNED=1`
(`MSIX_ALLOW_UNSIGNED=1 MAKEMSIX="$(sh scripts/makemsix.sh)" node scripts/msix.mjs` in
`desktop/`, after `electron-builder --win`), then, as an administrator:

```powershell
Add-AppxPackage -Path .\Cenacle-0.99.0-x64.msix -AllowUnsigned
```

Do not submit that package: the Store needs the publisher from Partner Center.

Run the Windows App Certification Kit (from the Windows SDK) on the package to see the
checks the Store runs.
