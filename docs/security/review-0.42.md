# Security review 0.42

What was tested for 0.42, how, what was found and fixed, and what is left for a manual
penetration test by people outside the project ([pentest guide](pentest-guide.md)).
Together with the code review of 0.41 (ADR 0044), this is the security work before the
release candidate.

## Scope

The chat server, Cenacle ID, the web app, the desktop app and the Compose and Helm
deployments of 0.41/0.42. Tested against a production stack (`prod.yml`, TLS by the
proxy, all seven images) on a closed Docker network, and in the test suites.

## Method and results

| Area                                | How                                                                                                 | Result                                                                                                                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependencies                        | `govulncheck`, `pnpm audit --prod`, Trivy on the source and on all seven images                     | One JavaScript library (`fast-uri`, through Fastify) had moderate advisories: updated. One Go advisory concerns a package Cenacle does not use. Images: no fixable HIGH/CRITICAL vulnerabilities.                      |
| Web scanning                        | OWASP ZAP 2.17 baseline (passive) against the app and Cenacle ID, signed out                        | No failures (62 and 67 checks passed). Warnings are the deliberate ones of earlier scans (caching of hashed assets, inline styles, no COEP) and a false positive ("10.0.0.0" in the app's code is an example address). |
| Authorization                       | `TestOutsidersReachNothing`, driven by the OpenAPI document (every operation that names a resource) | Now also as a **guest** of the workspace, against a public channel they are not in (beside outsiders and members outside a private channel). Nothing succeeds and nothing fails on the server.                         |
| OAuth 2.0 / OIDC profile (RFC 9700) | New tests against Cenacle ID                                                                        | Refused: other or extended redirect addresses, missing PKCE, PKCE `plain`, the implicit and hybrid flows, unknown clients; no code is ever sent elsewhere. A code works only with its verifier and only once.          |
| Files                               | New test                                                                                            | HTML, SVG and scripts are only downloaded (`application/octet-stream`, `attachment`, `nosniff`, a sandboxing CSP); images and media are shown inline with the same CSP.                                                |
| Imported files                      | New fuzz targets for the Rocket.Chat, Zulip, Discord, Teams and Cenacle readers and Teams' HTML     | No panics; part of `make fuzz` (100,000 inputs each in CI, 12 targets in all).                                                                                                                                         |
| Desktop app                         | Electronegativity 1.10.3 on the source                                                              | Only the deliberate, documented notes ([README](README.md#the-desktop-app-030)).                                                                                                                                       |
| End-to-end encryption               | Review of how Cenacle uses ts-mls                                                                   | See below.                                                                                                                                                                                                             |
| Earlier findings                    | The 0.41 review (60 findings in five areas, all closed)                                             | See the 0.41 changelog and ADR 0044.                                                                                                                                                                                   |

Already tested on every change and unchanged: CSRF (origin check on every
state-changing cookie request), session cookies (`HttpOnly`, `Secure`, `SameSite=Lax`),
WebSocket tickets that work once, rate limits, SSRF protection of the egress client
(private ranges, NAT64, 6to4, no redirects), escrow and backup cryptography against
WebCrypto vectors.

## End-to-end encryption: use of ts-mls

- Credentials are basic credentials `"<user>:<device>"`; a device accepts one only when
  its signature key matches the key the server lists for that device. **The server's
  device list is trusted** for this: a server that is not trusted could list a device
  of its own for someone. People notice it by comparing fingerprints (channel details);
  there is no key transparency log.
- Revoked devices stay valid credentials, so that what they sent before stays readable.
  The server refuses group changes from them, and the next member removes them from
  the group. A member with a modified app could add one back: they can read the
  channel already, so this gives them nothing new.
- Since 0.41 the sender's user id is inside each message and an envelope is accepted
  for one message only (ts-mls does not tell which member sent an application
  message).
- ts-mls 1.6.4 itself has had no independent audit. This review covers how Cenacle uses
  it, not the library; an audit of the library is an item for people outside the
  project.

## Changes in 0.42

- `fast-uri` updated (pnpm override) for its advisories.
- Tests: the guest pass of the authorization matrix, the OIDC profile refusals and
  PKCE binding, the serving of risky file types; fuzz targets for imported files.
- `ci/zap.sh` can scan from a Docker network (`ZAP_NETWORK`).

## Not done here

A manual penetration test (business logic, chained attacks, the desktop app at runtime,
the identity providers and directories in a real network) and an audit of ts-mls need
testers outside the project: the [pentest guide](pentest-guide.md) gives them the scope,
the setup and the checklist.
