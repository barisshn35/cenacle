// SPDX-License-Identifier: AGPL-3.0-only
import type { OutgoingHttpHeaders } from 'node:http';
import type { CancellationToken } from 'electron-updater';
import { GenericProvider } from 'electron-updater/out/providers/GenericProvider.js';
import { verifyUpdateFile } from './update-signature.js';

/**
 * The paired server's /downloads/desktop/, believed only when the release key
 * signed what it says: the update file (version, installer names, their
 * sha512) must come with a valid <name>.sig. The installer is then checked
 * against the signed sha512, so the server can host an update but not make
 * one.
 */
export class SignedProvider extends GenericProvider {
  constructor(
    options: object,
    updater: ConstructorParameters<typeof GenericProvider>[1],
    runtime: ConstructorParameters<typeof GenericProvider>[2],
  ) {
    super(
      { provider: 'generic', url: String((options as { url?: unknown }).url) },
      updater,
      runtime,
    );
  }

  protected override async httpRequest(
    url: URL,
    headers?: OutgoingHttpHeaders | null,
    cancellationToken?: CancellationToken,
  ): Promise<string | null> {
    const text = await super.httpRequest(url, headers, cancellationToken);
    const sigURL = new URL(url.href);
    sigURL.pathname += '.sig';
    const signature = await super.httpRequest(sigURL, headers, cancellationToken);
    const name = decodeURIComponent(url.pathname.split('/').pop() ?? '');
    if (
      text == null ||
      signature == null ||
      !verifyUpdateFile(name, Buffer.from(text, 'utf8'), signature)
    ) {
      throw new Error(`${name} is not signed with the release key`);
    }
    return text;
  }
}
