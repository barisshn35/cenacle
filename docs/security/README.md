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
| Uploaded files                      | Malware, scripts served from the app's origin                               | Optional ClamAV scan, size limits, files served with `Content-Disposition`, `nosniff` and a sandboxing CSP                                                                                                                                     |
| The web app                         | Script injection                                                            | Markdown rendered without raw HTML and sanitized; strict CSP (`script-src 'self'`, no third-party origins); `frame-ancestors 'none'`                                                                                                           |
| Integrations                        | Forged requests to bots, leaked tokens                                      | Requests to bots and other servers signed with HMAC-SHA256 and a timestamp; bot tokens, webhook addresses and invitation tokens stored hashed and shown once                                                                                   |
| Encrypted channels                  | The server or its operators reading them                                    | Keys come from a passphrase members share outside Cenacle and stay on their devices; the server stores envelopes only (ADR 0028)                                                                                                               |
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

The key is set up once per GitLab project with `ci/setup-signing.sh` (it keeps the private
key only in protected CI/CD variables and protects `v*` tags); a release without it is
published unsigned and its pipeline says so.

## Scanning a running installation

`ci/zap.sh <url>` runs the OWASP ZAP baseline scan (passive) against an installation and
writes `zap-report.html`; run it against a test installation, not production.

Last scan of the web app (0.26.0): no failures, 63 checks passed. The remaining warnings
are deliberate: hashed assets are cacheable for a year; `style-src 'unsafe-inline'` is
needed for the inline styles of animations and the theme; `Cross-Origin-Embedder-Policy`
is not set, as nothing cross-origin is loaded and it would only restrict later embeds.

## Hardening checklist for operators

- Keep `CENACLE_TLS_MODE` on a real certificate; the proxy sends `Strict-Transport-Security`.
- Leave `CENACLE_EGRESS_ALLOW` empty unless bots or federated servers live on your network,
  and then list only their networks.
- Back up the databases, the object store and Cenacle ID's signing keys
  ([backup guide](../backup/README.md)).
- Turn on two-step verification or passkeys for owners and admins.
- Upgrade to every release: only the latest minor version gets security fixes.
