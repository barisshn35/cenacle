# QA report: 0.99.0

The release candidate tested along the [test plan](test-plan.md), 2026-10-25. Every finding
below that is marked fixed was fixed before the release, with a test that fails without the fix
where one could be written.

## Result

No blocker or major finding is open. Two major and seven minor findings were fixed; what could
not be tested here, and why, is listed at the end.

## Automated suites

| Suite                                  | Result                                                                                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit and integration (server, ID, web) | pass                                                                                                                                                           |
| Web journeys, Chromium (mouse, touch)  | pass                                                                                                                                                           |
| Web journeys, Firefox and WebKit       | 358 of 364 at first; the 6 failures are findings 3, 4 and a test that reads the favicon in a way only Chromium supports (now skipped elsewhere); then all pass |
| Whole stack, Cenacle ID, desktop app   | pass (the desktop suite gained a test of the organization policy)                                                                                              |
| Security scans (gitleaks, trivy)       | pass                                                                                                                                                           |

## Operations

- **Install from the documentation only** ([install](../install/README.md)): 0.43.0 with
  Compose, `gen-secrets.sh`, `.env.prod`, internal TLS, the first administrator with the
  Cenacle ID command. Every service healthy; signing in enrolled two-step verification.
- **Upgrade with data:** 120 messages, a thread, a reaction, a pin and a file in the object
  store on 0.43.0, then the 0.99 files and images with the same `.env.prod` and `secrets/`.
  Migration 00047 applied; the session survived; history, thread, pin, reaction and file were
  intact; signing in again (with the second step) worked; the new AI notice route answered.
- **Roll back:** `migrate down` with the new image, then the 0.43.0 files and images: all data
  intact.
- **Restore:** messages deleted on purpose, then the dumps taken before the upgrade restored
  with `pg_restore --clean` as the backup guide says: everything back. Upgraded to 0.99 again
  and verified.
- **Desktop packages:** the deb installed and the app started on Ubuntu 24.04 and Debian 12,
  the rpm on Fedora 42, each in a container on the test host (not on machines); the Linux policy file paired the app with the organization's server.
  The MSI (built with msitools) and the MSIX packages (checked by unpacking with Microsoft's
  validating parser) were built and inspected.

## Findings

| #   | Where              | What happened                                                                                                                 | Severity | Fixed in |
| --- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- | -------- | -------- |
| 1   | Messages on phones | The author and time were drawn over the words: the touch toolbar opened a second column in the one-column layout.             | major    | b56827f  |
| 2   | Desktop app, Linux | On a minimal system the deb and rpm did not pull NSS, GTK or ALSA, so the app did not start; apt could take an ALSA stand-in. | major    | f1f5d6a  |
| 3   | Safari (WebKit)    | Selects reached with the keyboard showed no focus ring (WebKit draws no shadow around a select).                              | minor    | d161d11  |
| 4   | Firefox            | Two checkboxes (permissions, federation) were 16 px to hit: Firefox draws no hit-area pseudo-element on an input.             | minor    | d161d11  |
| 5   | Settings           | "Keyboard shortcuts" wrapped onto two lines beside its shortcut.                                                              | minor    | b56827f  |
| 6   | Channel details    | Several owners were cut off; "Retention: Workspace's" was unclear (now "Workspace policy").                                   | minor    | b56827f  |
| 7   | Tasks              | The empty state repeated the page's description word for word.                                                                | minor    | b56827f  |
| 8   | Sizes              | "0 byte" instead of "0 bytes".                                                                                                | minor    | b56827f  |
| 9   | Interface texts    | An unused "Not available yet" text was still shipped.                                                                         | minor    | e8eace3  |

## Seen and left as they are

- In a narrow thread panel, long names are shortened with an ellipsis; the full name is in
  the profile card.
- In the avatars of a thread's repliers, each avatar covers part of the previous one, as
  avatar stacks do.

## Not tested here

- **Windows:** no Windows computer was available. The MSI and MSIX were built and inspected
  on Linux, not installed. The Microsoft Store runs its certification on the MSIX at
  submission ([publishing](../desktop/microsoft-store.md)).
- **Kubernetes:** the Helm chart is linted and rendered in CI; it was not installed on a
  cluster for this release.
- **A network without internet:** the installation ran from local images with internal TLS
  and link previews off, but the network was not cut off.
- **Screen readers:** no session with people who use them every day
  ([conformance report](../accessibility/conformance-report.md)).
