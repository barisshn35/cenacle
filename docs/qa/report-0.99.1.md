# QA report: 0.99.1

0.99.1 is a hardening round on the release candidate before 1.0: the repository's history,
its supply chain and licenses, attacks on a running installation, failures of its parts,
restores, upgrades from old versions, Kubernetes, the encryption library against the MLS
standard, keyboard and screen reader use, long fuzzing and a day-long run. Every finding
below that is marked fixed was fixed in 0.99.1, with a test that fails without the fix
where one could be written. 2026-10-26 to 2026-10-27.

## Result

No blocker is open. Eleven major and sixteen minor findings were fixed; what was looked at
and left as it is, and what could not be tested here, is listed at the end.

## Findings

| #   | Where             | What happened                                                                                                                                                        | Severity | Fixed in                        |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------- |
| 1   | Licenses          | The images, the web app and the desktop app shipped no third-party notices, which MIT, BSD and Apache-2.0 ask for in every copy passed on.                           | major    | c65675b                         |
| 2   | Licenses          | The app did not offer its source to the people using it (AGPL-3.0 section 13).                                                                                       | major    | ee8de09                         |
| 3   | Desktop app       | A page could ask to return after signing in to `/\host`, which URL parsing reads as another site, shown in the main window without an address bar.                   | major    | c13554a                         |
| 4   | Network partition | A database that stopped answering held each query for the system's TCP timeout (minutes); requests piled up.                                                         | major    | 9079c59                         |
| 5   | Network partition | The same in Cenacle ID: sign-in pages hung for as long as the partition lasted.                                                                                      | major    | db01348                         |
| 6   | Retention         | On three million messages the retention job read every message (and checked legal holds on each) every two minutes and hit its time limit, also without a retention. | major    | 475752e                         |
| 7   | Encryption        | A device the server still listed after a commit removed it rejoined with "resync", which loops forever in ts-mls 1.x: its tab froze in that channel.                 | major    | 361a37f                         |
| 8   | Keyboard          | When the virtual message list dropped the row holding focus, focus fell to the page and the next Tab started over at the top.                                        | major    | f0ec480                         |
| 9   | Documentation     | The upgrade guide only changed the version: new deploy files, settings and secrets were missing; a migration's time was understated tenfold.                         | major    | a5be660                         |
| 10  | Documentation     | The first account: the example ran without a terminal (the password showed, asked once); Helm's notes failed without `-it`; the Kubernetes guide lacked the step.    | major    | a2cba0a, ecbf16d                |
| 11  | Images            | A small image file could claim a large image: a 500 kB PNG decoded to 480 MB, a 19 kB strip took 920 MB to scale (pictures, attachments, link previews).             | major    | 0acc756                         |
| 12  | Helm              | A profile added in this round (AppArmor) made nodes without AppArmor refuse the pods; found installing the chart, before the release.                                | minor    | 1312038                         |
| 13  | Desktop app       | `cenacle://` links could open the server's API or WebSocket addresses (also percent-encoded).                                                                        | minor    | c13554a                         |
| 14  | Server            | Text holding NUL failed with 503 instead of 400 (banner, terms, audit stream, push subscriptions).                                                                   | minor    | a723934                         |
| 15  | Integrations      | A Jira, GitLab, GitHub, Alertmanager or e-mail card kept a NUL or invalid UTF-8: the whole delivery was refused.                                                     | minor    | f32ab41                         |
| 16  | Headers           | API responses and Cenacle ID's pages had no Cross-Origin-Resource-Policy.                                                                                            | minor    | a723934, b7124aa                |
| 17  | Cenacle ID        | Opening a signing key accepted a GCM tag of any length (stored ones are always 16 bytes).                                                                            | minor    | 3195297                         |
| 18  | Supply chain      | npm packages had no minimum age or trust policy; Dependabot no cooldown.                                                                                             | minor    | f4c72ec                         |
| 19  | Supply chain      | Container images were named by tag only, and two of the three images differed between two builds of the same commit.                                                 | minor    | 18cbd05, a691a78                |
| 20  | Dependencies      | chi before 5.4 in the Caddy build and uuid before 11.1.1 in the mobile tooling (advisories; neither code path used).                                                 | minor    | cb39a9d                         |
| 21  | Helm              | Replicas could share a node; disruption budgets could block draining; the migration jobs had no resource limits.                                                     | minor    | 3646cf4                         |
| 22  | CI                | The runner took untagged jobs; pipelines of forks could run in the project; `release-*` branches were not protected; merges did not wait for the pipeline.           | minor    | c23d8bb and GitLab settings     |
| 23  | Documentation     | The installation did not ask for a right clock (two-step codes allow 30 seconds).                                                                                    | minor    | 12954a3                         |
| 24  | Repository        | A design prototype held a real public IP address as sample data.                                                                                                     | minor    | 610fdf6                         |
| 25  | Repository        | The closed pull requests of the GitHub mirror keep a history from before a rewrite (with tool attribution lines).                                                    | minor    | at 1.0: the mirror is recreated |
| 26  | Interface         | Appearance had two settings named "Theme"; counts in the console's side menu and boards ignored the language (1240 in Turkish); thread summaries cut the initials.   | minor    | f02ae9e                         |
| 27  | Tests             | The soak test kept every closed connection until it ended and outlived its people's sessions: a day-long run reported a leak and failed requests that were its own.  | minor    | 9d154bf                         |

## What was done

### Repository and supply chain

- **History:** gitleaks (the project's rules and the defaults) and trufflehog over all 351
  commits of every branch: no secret. The 13 trufflehog matches are test data, a GUID and a
  variable name.
- **Licenses:** notices are now built from what each image and app contains (Go modules,
  the web bundle, Cenacle ID's and the desktop app's packages) and shipped under `/licenses`,
  `/third-party-notices.txt` and the app's resources; Settings → Account links them and the
  source code.
- **Static analysis:** semgrep (Go, TypeScript, React, Node, OWASP, JWT, Dockerfile rule
  sets, 403 rules on 867 files): two hardening fixes (17, 18), the rest not applicable (a
  cookie's `Secure` follows the address; Android's launcher must be exported). gosec runs in
  the lint already.
- **OpenSSF Scorecard** (local): binaries only in untracked tool folders; images now pinned
  by digest (Dependabot keeps them current); three advisories found and handled (20, and
  `x/crypto/openpgp`, a module-wide advisory for a package Cenacle does not use).
- **Reproducible images:** the server, Cenacle ID and web images, built twice from the same
  commit, are now identical bit for bit; release images are built that way, and the security
  guide shows how to rebuild one and compare it. Build provenance (SLSA, BuildKit's `mode=max`)
  was already attached and signed.
- **Electron:** the packaged app's fuses read back as set (no `RunAsNode`, asar integrity,
  cookie encryption, no inspector); Electronegativity's findings are covered (navigation is
  confined, IPC checks its sender and arguments); deep links and the sign-in return were
  fixed (3, 13) and are tested with 20 000 random links.

### A running installation (Compose, internal TLS)

- **OWASP ZAP 2.17:** an authenticated scan of the whole API from its OpenAPI description
  (310 operations, minus 8 that end the session or lock out the administrator): 117 rules
  pass, none fails; Cenacle ID's pages and its sign-in flow: 142 and 139 pass, none fails.
  Two findings fixed (14, 16); the rest are informational (the sign-in form's protection is
  its origin check; a 303 redirect read as "source disclosure").
- **nuclei** (14 104 templates) against both hosts: nothing at low severity or above.
- **TLS** (testssl.sh): TLS 1.2 and 1.3 only, forward secrecy, HSTS for a year, every header
  set; 96 of 100, the grade held at B only by the test's internal certificate authority.
- **Brute force:** ten failed passwords a minute per address, also with forged
  `X-Forwarded-For` headers; ten per account in fifteen minutes from any number of addresses,
  after which even the right password is refused, indistinguishably; two-step codes are
  limited per sign-in and per account; every token and secret address is 256 bits.
- **Without the internet:** for 20 minutes covering a restart, use and every failure below,
  not one packet left the installation's networks (a control packet from a test container was
  seen).

### Failures (messages sent at 1.5 a second; every acknowledged message checked afterwards)

| What failed                                   | What happened                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| PostgreSQL stopped for 15 s                   | 503 within 72 ms meanwhile; recovered by itself; no message lost          |
| Valkey stopped for 15 s                       | 503 meanwhile (sending is limited through Valkey); recovered; none lost   |
| Valkey full (1 MB limit) for 20 s             | 503 meanwhile; recovered; none lost                                       |
| Cenacle ID stopped for 15 s                   | chat unaffected: 61 of 61 sent                                            |
| Garage stopped for 15 s                       | 7 uploads failed at the store; recovered; 18 of 18 files read back intact |
| Server cut off from its databases for 60 s    | after the fix (4): 503 within at most 15 s; recovered; none lost          |
| Cenacle ID cut off from its database for 60 s | after the fix (5): its error page within 30 s, then 2 s; recovered        |

### Backups, keys and upgrades

- **Restore:** dumps, secrets and an rclone copy of the files; then the installation deleted
  with all its volumes and restored from the backup guide: 457 of 457 messages, the session
  still signed in, the same signing key, 24 of 24 files identical; signing in with the
  password and the second step worked.
- **Signing keys:** `keys rotate` published the new key beside the old, `keys prune` kept the
  old one for its grace period, and signing in afterwards worked.
- **Upgrades:** installations of 0.30.0, 0.35.0 and 0.40.0, each from its own release's
  files and filled, upgraded directly to 0.99.1 with the guide's steps: about 45 seconds each,
  the session kept, every item there. A 0.30 database with three million messages and a
  million mentions: healthy after 67 seconds, 34 of them migrations (00046: 29 s), which led to
  findings 6 and 9.

### Kubernetes (k3d: one server and two agents, k3s 1.35)

PostgreSQL, Valkey and Garage in the cluster and the chart installed as the guide describes
(after finding 12): 21 seconds, replicas on different nodes; signing in, two-step setup and
files through the ingress worked. `helm upgrade` while messages were sent: 225 of 225;
`helm rollback`: 135 of 135. With the network policy on, everything worked and a pod outside
the release could not reach the server.

### Encryption (MLS)

- The ts-mls package Cenacle ships (1.6.4) is byte for byte the build of its tagged source,
  and passes all 785 test vectors of the MLS working group.
- With OpenMLS 0.9.1 (an independent implementation) in one group: application messages,
  commits and the exporter secret agree both ways. External joins do not, because ts-mls 1.x
  writes `external_pub` without its length (RFC 9420 §12.4.3.2; upstream issues #449 and
  #831): no effect between Cenacle's own devices; moving to a fixed ts-mls needs a planned
  step ([security](../security/README.md#end-to-end-encryption-with-device-keys-039)).
- Finding 7 (a frozen tab) came from the same upstream issue, reproduced and guarded against.

### Keyboard and screen readers

Every focus stop of a channel, Settings and the quick switcher, in English and Turkish, read
from the browser's accessibility tree (what a screen reader announces): every stop named,
nothing left in English in Turkish, landmarks and headings in order; messages from others
are announced by the list's status region in both languages. Finding 8 came from this pass.

### Fuzzing

All 22 fuzz targets of the server, ten minutes each with six workers (about 400 million
inputs): message search terms, mentions, WebSocket envelopes, MLS headers, links, reminders
and page metadata; the importers of Rocket.Chat, Zulip, Discord, Teams and Cenacle; images
and pictures; the cards of Jira, GitLab, GitHub, Alertmanager and e-mail, feeds and webhook
signatures. 21 ran clean. The picture target stopped at its deadline without a failing
input; looking for why, the time and memory each image takes were measured, which led to
finding 11. After the fix both image targets ran another ten minutes clean.

### A day-long run

24 hours of `TestSoak` against PostgreSQL and Valkey on this host: 20 messages a second from
50 people, 200 live connections of which 40 were replaced every minute (57,600 in the day).
1,726,892 messages were sent and 346 million events delivered. Goroutines stayed at 824 to
825 and database connections between 6 and 9 from the first sample to the last; Valkey stayed
at 6 MiB; the test database grew from 88 MB to 1.2 GB. PostgreSQL's container went from 196
to 388 MiB, which was its shared buffers and the cache of the growing database: its
processes used 31 MB, and it fell to 209 MiB once the run ended.

The run failed its own checks twice, both in the test (finding 27): the last 91 messages were
refused with 401, because the test signs its people in once and the test server ends sessions
after 24 hours, as it should; and the heap grew evenly from 26 to 180 MB. A heap profile
showed the growth in the test's own connections: each kept a clean-up until the end of the
test, holding about 2 kB per closed connection. The server's part of the heap did not grow
with them. Fixed, the same profile was flat, and an hour at 1,000 connections and 1,000
replacements a minute (60,000 in the hour, more than the whole day before) with 20
messages a second ended with no failed request, the heap between 43.7 and 46.1 MB and 4,024
goroutines throughout.

## Seen and left as they are

- **BREACH** (testssl): no secret is echoed in responses, and the session cookie is
  `SameSite=Lax`, so other sites cannot make the requests the attack needs.
- **The Valkey password reaches the server as a variable** on Kubernetes: the key is
  optional, and a missing key in a mounted file would keep the pods from starting.
- **An account can be locked for 15 minutes** by ten wrong passwords: the usual price of
  stopping password guessing from many addresses.
- **Uploads stopped by an outage** stay "uploading" until the daily clean-up removes them.
- **Repeated button names** in messages ("Add reaction" on each): each message is an
  article named by its author, which screen readers read first.

## Not tested here

- **Windows:** no Windows computer; the user's checklist covers setup, the MSI and policies.
- **Orca on a virtual display:** Chromium exposed its full accessibility tree, but no keyboard
  event reached Orca in the container; the pass above read the same tree directly. No session
  with people who use screen readers every day.
- **A full disk and a wrong clock:** the host's disk and clock are shared with other
  services; the clock requirement is now documented (23).
- **Cenacle ID's SAML and OIDC parsing** was not fuzzed (Node; it uses maintained
  libraries); the server's fuzzing is above.
