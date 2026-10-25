#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Packs the Windows builds (release/win-unpacked, release/win-arm64-unpacked)
// as MSIX packages for the Microsoft Store, which signs them when it publishes
// them (docs/desktop/microsoft-store.md). makemsix comes from Microsoft's
// msix-packaging (scripts/makemsix.sh builds it); MAKEMSIX names it.
//
// The package identity comes from Partner Center: MSIX_IDENTITY_NAME,
// MSIX_PUBLISHER (CN=…) and MSIX_PUBLISHER_DISPLAY_NAME. Without them the
// packages carry placeholder values that the Store refuses.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = join(root, 'release');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const makemsix = process.env.MAKEMSIX || 'makemsix';

const xml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c],
  );

const identity = {
  name: process.env.MSIX_IDENTITY_NAME || 'Cenacle.Desktop',
  publisher: process.env.MSIX_PUBLISHER || 'CN=Cenacle',
  publisherName: process.env.MSIX_PUBLISHER_DISPLAY_NAME || 'Cenacle contributors',
};
// For testing on Windows 11 without a signature (Add-AppxPackage -AllowUnsigned):
// Microsoft's marker of unsigned packages, never for the Store.
if (process.env.MSIX_ALLOW_UNSIGNED)
  identity.publisher += ', OID.2.25.311729368913984317654407730594956997722=1';
// The Store wants four numbers with the last one 0.
const [major, minor, patch] = version.split('-')[0].split('.').map(Number);
const packageVersion = `${major}.${minor}.${patch}.0`;

export function manifest(arch) {
  return `<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <Identity Name="${xml(identity.name)}" Publisher="${xml(identity.publisher)}" Version="${packageVersion}" ProcessorArchitecture="${arch}" />
  <Properties>
    <DisplayName>Cenacle</DisplayName>
    <PublisherDisplayName>${xml(identity.publisherName)}</PublisherDisplayName>
    <Logo>assets\\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
    <Resource Language="tr-tr" />
  </Resources>
  <Applications>
    <Application Id="Cenacle" Executable="app\\Cenacle.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Cenacle" Description="Team chat on your own server"
        BackgroundColor="transparent" Square150x150Logo="assets\\Square150x150Logo.png" Square44x44Logo="assets\\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="assets\\Wide310x150Logo.png" Square71x71Logo="assets\\Square71x71Logo.png" Square310x310Logo="assets\\Square310x310Logo.png" />
      </uap:VisualElements>
      <Extensions>
        <uap:Extension Category="windows.protocol">
          <uap:Protocol Name="cenacle">
            <uap:DisplayName>Cenacle</uap:DisplayName>
          </uap:Protocol>
        </uap:Extension>
      </Extensions>
    </Application>
  </Applications>
  <Capabilities>
    <Capability Name="internetClient" />
    <Capability Name="privateNetworkClientServer" />
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
`;
}

const builds = [
  ['win-unpacked', 'x64'],
  ['win-arm64-unpacked', 'arm64'],
].filter(([dir]) => existsSync(join(release, dir)));
if (builds.length === 0) {
  console.error('No Windows build in release/: run electron-builder --win first.');
  process.exit(1);
}
for (const [dir, arch] of builds) {
  const stage = join(release, `msix-${arch}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  cpSync(join(release, dir), join(stage, 'app'), { recursive: true });
  cpSync(join(root, 'build', 'appx'), join(stage, 'assets'), { recursive: true });
  writeFileSync(join(stage, 'AppxManifest.xml'), manifest(arch));
  const out = join(release, `Cenacle-${version}-${arch}.msix`);
  rmSync(out, { force: true });
  execFileSync(makemsix, ['pack', '-d', stage, '-p', out], { stdio: 'inherit' });
  rmSync(stage, { recursive: true, force: true });
  console.log(`${out} (${identity.name}, ${packageVersion})`);
}
