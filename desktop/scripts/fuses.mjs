// SPDX-License-Identifier: AGPL-3.0-only
// Turns off what an attacker could use to run code through the app binary
// (Electron fuses): running as plain Node, NODE_OPTIONS, the inspector
// flags; and checks that the app code comes only from its integrity-checked
// archive.
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';
import path from 'node:path';

export default async function afterPack(context) {
  const name = context.packager.appInfo.productFilename;
  const ext = { win32: '.exe', linux: '' }[context.electronPlatformName] ?? '';
  const binary =
    context.electronPlatformName === 'linux'
      ? path.join(context.appOutDir, context.packager.executableName)
      : path.join(context.appOutDir, `${name}${ext}`);
  await flipFuses(binary, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: false,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });
}
