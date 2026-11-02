// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The public keys (Ed25519) whose signature an update needs: the release
 * key of the Cenacle project. An organization that builds the app itself
 * puts its own key here (docs/operations/ci.md). The server the
 * app is paired with only hosts the files: it cannot sign them.
 */
export const UPDATE_KEYS: readonly string[] = [
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAkEkv05Y3rg3Q6wHz/vxHZpnkopz9DZr1XeeSqyRKmas=
-----END PUBLIC KEY-----`,
];
