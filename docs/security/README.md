# Security

How Cenacle is protected, what is tested on every change, and what operators should do.
To report a vulnerability, see [SECURITY.md](../../SECURITY.md).

## Threat model

| Asset                               | Threat                                                                      | Protection                                                                                                                                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts                            | Stolen passwords, phishing, session theft                                   | Cenacle ID: Argon2id, two-step verification, passkeys, sign-in rate limits; OIDC with PKCE (RFC 9700); opaque sessions stored hashed, `HttpOnly; Secure; SameSite=Lax` cookies, idle and absolute expiry, back-channel logout                  |
| Conversations                       | People reading channels they are not in                                     | Every request checks workspace and channel membership on the server; private channels answer 404 to outsiders; tested for every API operation (below)                                                                                          |
| Requests made with someone's cookie | Cross-site request forgery                                                  | `SameSite=Lax` and an origin check on every state-changing request with a session cookie                                                                                                                                                       |
| The server's network                | Server-side request forgery through bots, workflows, previews, federation   | One egress client: public `https` only, private networks only when listed in `CENACLE_EGRESS_ALLOW`, no redirects, bounded answers                                                                                                             |
| Uploaded files                      | Malware, scripts served from the app's origin, images that exhaust memory   | Optional ClamAV scan, size limits, files served with `Content-Disposition`, `nosniff` and a sandboxing CSP; images decoded within a memory budget (small files claiming huge images are refused)                                               |
| The web app                         | Script injection                                                            | Markdown rendered without raw HTML and sanitized; strict CSP (`script-src 'self'`, no third-party origins); `frame-ancestors 'none'`                                                                                                           |
| Integrations                        | Forged requests to bots, leaked tokens                                      | Requests to bots and other servers signed with HMAC-SHA256 and a timestamp; bot tokens, webhook addresses and invitation tokens stored hashed and shown once                                                                                   |
| Encrypted channels                  | The server or its operators reading them                                    | Device keys (MLS, RFC 9420): every device has its own key, the server orders commits and stores envelopes it cannot read; devices are verified by fingerprint; channels from before 0.39 keep their shared passphrase (ADRs 0028, 0042)        |
| Compliance data                     | Deletion of evidence, quiet exports                                         | Legal holds stop every kind of deletion; exports and holds are audited                                                                                                                                                                         |
| The desktop app                     | Token theft by scripts, phishing for the password, code run through the app | Session token encrypted by the OS and added by the app, never given to a page; sign-in at Cenacle ID's page in an isolated window showing its address; sandboxed, context-isolated renderers; Electron fuses; no device permissions (ADR 0033) |
| AI                                  | Conversations leaving the organization                                      | Off unless the operator runs a model and a workspace turns it on; only what the asker can read is sent (ADR 0029)                                                                                                                              |

## Tested on every change (CI)

- **Authorization matrix** (`TestOutsidersReachNothing`): every API operation that names a
  resource is called with the resources of a workspace the caller is not in, and again as a
  member of the workspace who is not in the private channel. None may succeed and none may
  fail on the server.
- **Fuzzing** of what people type (search terms for AI questions, mentions, encrypted
  envelopes, links, reminders): seeds with every test run, 100,000 inputs each in CI
  (`make fuzz`). Inputs that once failed stay as regression seeds in `testdata/fuzz`.
- **Dependencies and secrets:** `govulncheck`, Trivy (dependencies, secrets, Dockerfiles),
  gitleaks over the whole history, license checks; images run as non-root users.
- **Releases** are signed, with signed SBOMs (see below).
- **End-to-end:** accessibility (axe), no requests leave the app's origin, sign-in flows.
- **Desktop app:** against a stand-in server and the whole stack — the page never holds
  the token and no cookie is used, pages of other sites get no bridge, no menu, start-up
  and memory budgets, and a soak run (memory must level off while messages keep coming).

## The desktop app (0.30)

Reviewed against Electron's security checklist and with Electronegativity 1.10.3 (on the
source and the build). Its notes are deliberate:

- `CSP_GLOBAL_CHECK`: the app's own pages carry `default-src 'none'; script-src 'self'`.
- `PRELOAD_JS_CHECK`: the preloads expose a few named actions through `contextBridge`;
  the main process accepts them only from the paired server's top-level pages (or the app's
  own pages) and checks every argument.
- `PROTOCOL_HANDLER_JS_CHECK`: `cenacle://open/<path>` opens a path of the paired server
  only.
- `OPEN_EXTERNAL_JS_CHECK`: only `mailto:` addresses leave the app.
- `AUXCLICK_JS_CHECK`, `REMOTE_MODULE_JS_CHECK`: new windows go through the window-open
  handler; the remote module no longer exists in Electron.

Fuses of the packaged app: `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`,
`EnableNodeCliInspectArguments` and `GrantFileProtocolExtraPrivileges` off;
`EnableEmbeddedAsarIntegrityValidation`, `OnlyLoadAppFromAsar` and
`EnableCookieEncryption` on (checked with `npx @electron/fuses read`).

## End-to-end encryption with device keys (0.39)

A channel or conversation can be encrypted end to end (its managers, or anyone in a
conversation, turn it on; it cannot be turned off). Then:

- Every device that signs in creates its own signing key (Ed25519) and registers its
  public key; the private key stays in the browser's or desktop app's storage. A device
  removed in Settings → Account → Encryption keys leaves every encrypted channel with the
  next change of each group.
- Each channel has an MLS group (RFC 9420, cipher suite
  `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`, the library ts-mls). Devices of members
  join it on their own; devices of people who left and removed devices are removed by the
  next member device that comes by. The server orders the group's changes (one per epoch)
  and accepts messages only for the current epoch and the channel's own group.
- Files are encrypted in the browser with a key of their own that travels in the message;
  the server keeps them as "encrypted", without previews or virus scanning.
- People verify each other's devices by comparing fingerprints (channel details); a
  verified device shows a check mark on the device that verified it.
- A new device cannot read messages from before it joined. People who make a **recovery
  key** (Settings → Account) keep backups of what their devices read, sealed with it, and
  bring them to a new device by typing the key. A lost recovery key cannot be recovered;
  a new one deletes the old backups.
- **Escrow (optional):** an instance administrator can require that recovery keys are also
  sealed for an organization key (`PUT /api/admin/e2e/escrow` with a P-256 public key).
  Members are told. The private key stays offline; `server e2e-escrow <key.pem> <e-mail>
[channel]` opens that person's backups and is audited. Escrow reaches only what devices
  backed up, never messages directly. The escrow key comes from the server: the app
  says so before a recovery key is made, but a server that is not trusted could add one
  for recovery keys made later.

Since 0.41 every message carries its sender inside the encryption, and an envelope
opened for one message is not accepted again as another: the server cannot show one
person's message as someone else's or repeat an old one. Signing out removes the
device and everything it kept (keys, decrypted messages, drafts); scheduled messages,
commands that carry text, tabs and forums are not available in these channels.

What the server still knows: who is in which channel, which device sent changes, when
messages were sent and how long they are. Bots, search, link previews, AutoMod, AI,
scheduled messages and notifications with text do not work in encrypted channels.
ts-mls has not had an independent security audit; how Cenacle uses it was reviewed for 0.42
([review](review-0.42.md)).

**Standards checks (0.99.1).** The ts-mls version Cenacle ships (1.6.4, built from its
tagged source byte for byte) passes all 785 test vectors of the MLS working group
(mls-implementations, the 16 sets from tree math to passive clients). Against OpenMLS 0.9.1,
an independent implementation, application messages, commits and the exporter secret
agree in both directions, with one exception: ts-mls 1.x writes the `external_pub`
extension of a GroupInfo as the bare key, where RFC 9420 (§12.4.3.2) puts a length before
it, so neither side can join the other's group with an external commit (ts-mls issues
#449, fixed for 2.0, and #831). Between Cenacle's own devices this changes nothing, as
they all use the same library. Moving to a ts-mls with the fix needs a planned step: the
GroupInfo the server keeps for each encrypted channel was written the old way, so the new
version must still read it until every group has made a commit with the new one.

## Verifying a release (0.31)

Releases are signed with the project's key (cosign; the public key is
[`deploy/cosign.pub`](../../deploy/cosign.pub)). Signing uses no public transparency log,
so verifying needs only the public key and the registry — also without Internet access.

- **Images:** each image index and every image it names (each platform, the build
  provenance) is signed:

  ```sh
  cosign verify --key deploy/cosign.pub --insecure-ignore-tlog \
    git.calaixo.com:5050/calaxio/cenacle/cenacle-server:0.31.0
  ```

  (`--insecure-ignore-tlog` only says there is no transparency log to check.)

- **SBOMs:** each platform's image carries a signed SPDX SBOM (made by syft). Verify and
  read it for the image of your platform, by its digest:

  ```sh
  cosign verify-attestation --key deploy/cosign.pub --insecure-ignore-tlog --type spdxjson \
    git.calaixo.com:5050/calaxio/cenacle/cenacle-server@sha256:<digest of linux/amd64>
  ```

  The same SBOMs are published with each release in the package registry as
  `cenacle-sbom/<version>/cenacle-<image>-<version>-linux-<arch>.spdx.json`. The images
  also carry BuildKit's own SBOM and provenance attestations
  (`docker buildx imagetools inspect <image> --format '{{ json .SBOM }}'`).

- **Desktop app:** `SHA256SUMS` lists the installers and packages of a release, and
  `SHA256SUMS.sigstore.json` signs it:

  ```sh
  cosign verify-blob --key deploy/cosign.pub --insecure-ignore-tlog \
    --bundle SHA256SUMS.sigstore.json SHA256SUMS
  sha256sum --check --ignore-missing SHA256SUMS
  ```

- **Linux packages (0.99):** the rpm packages are signed with the project's GPG key, and
  `SHA256SUMS.asc` signs the checksums for tools that know GPG rather than cosign. The
  public key is `cenacle-linux.asc` in each release:

  ```sh
  sudo rpm --import cenacle-linux.asc && rpm -K Cenacle-0.99.0-x86_64.rpm
  gpg --import cenacle-linux.asc && gpg --verify SHA256SUMS.asc SHA256SUMS
  ```

- **Rebuilding an image yourself (0.99.1):** the images are reproducible: built from the
  release's tag, with the commit's time as every file's time, they come out bit for bit the
  same, so anyone can check that a published image holds exactly the released source:

  ```sh
  git checkout v0.99.1
  docker buildx build -f server/Dockerfile --build-arg VERSION=0.99.1 \
    --build-arg SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)" --platform linux/amd64 \
    --label org.opencontainers.image.title=cenacle-server \
    --label org.opencontainers.image.licenses=AGPL-3.0-only \
    --label org.opencontainers.image.version=0.99.1 \
    --provenance=false --output type=oci,dest=server.tar,rewrite-timestamp=true .
  ```

  The digest of the linux/amd64 image in `server.tar` (its `index.json`) matches the one the
  published index names for linux/amd64 (`docker buildx imagetools inspect <image>`). The
  same holds for `idp/Dockerfile` and `web/Dockerfile` (with their own title label).

The key is set up once per GitLab project with `ci/setup-signing.sh` (it keeps the private
key only in protected CI/CD variables and protects `v*` tags); a release without it is
published unsigned and its pipeline says so. The GPG key of the Linux packages is set up the
same way with `ci/setup-linux-signing.sh`.

## Security reviews

- [Review 0.42](review-0.42.md): what the project tested before the release candidate
  (dependencies, scans, the authorization matrix, the OAuth profile, files, fuzzing).
- [QA report 0.99.1](../qa/report-0.99.1.md): the hardening round before 1.0 (the
  repository's history, supply chain and licenses, OWASP ZAP and nuclei against a running
  installation, brute force, failures and network partitions, restores, Kubernetes, MLS test
  vectors and OpenMLS, fuzzing, a day-long run).
- [Pentest guide](pentest-guide.md): scope, a test installation and a checklist for a
  manual penetration test by people outside the project.

## Scanning a running installation

`ci/zap.sh <url>` runs the OWASP ZAP baseline scan (passive) against an installation and
writes `zap-report.html`; run it against a test installation, not production.

Last scan of the web app (0.26.0): no failures, 63 checks passed. The remaining warnings
are deliberate: hashed assets are cacheable for a year; `style-src 'unsafe-inline'` is
needed for the inline styles of animations and the theme; `Cross-Origin-Embedder-Policy`
is not set, as nothing cross-origin is loaded and it would only restrict later embeds.

## Hardening checklist for operators

For FIPS 140-3 images see [fips.md](fips.md); for a deployment in line with DISA STIGs
(notice and consent banner, limits, the requirement areas) see [stig.md](stig.md).

- Keep `CENACLE_TLS_MODE` on a real certificate; the proxy sends `Strict-Transport-Security`.
- Leave `CENACLE_EGRESS_ALLOW` empty unless bots or federated servers live on your network,
  and then list only their networks.
- Back up the databases, the object store and Cenacle ID's signing keys
  ([backup guide](../backup/README.md)).
- Turn on two-step verification or passkeys for owners and admins.
- Upgrade to every release: only the latest minor version gets security fixes.
