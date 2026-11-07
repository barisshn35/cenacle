# QA report: the full run before 1.0

A full QA run on `main` after 0.99.5, meant to reach every feature: every operation of the
API on a real stack, every role's journey in the browser, a team's day, AI with a real
model, and the operations an administrator goes through (install, backup, restore, upgrade
and rollback). 2026-11-07.

## Result

No blocker is open. Two major and four minor findings were fixed on `main`. Of the API's 319
operations, 307 ran successfully on the real stack; the other 12 are the server-to-server
and app-only ones, which the Go integration tests run (see Coverage).

## Findings

| #   | Where      | What happened                                                                                                                                                                                 | Severity | Fixed in |
| --- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------- |
| 1   | Cenacle ID | Node.js 26 can abort the whole process when V8 deoptimizes after a fast API call (nodejs/node#66870); it happened in the web app's test server. Cenacle ID's image runs Node.js the same way. | major    | fcd7d93  |
| 2   | Messages   | A channel read at its end slid 67 px up when a picture above it loaded late, and new messages stopped following; someone who had scrolled up had no sign that new messages arrived.           | major    | 9b9d30b  |
| 3   | Landing    | Signing in opened the first channel in the list, so a new channel whose name sorts before General moved where everyone landed.                                                                | minor    | 7eacc86  |
| 4   | Messages   | A small image (an icon, 2×2 in the test) was blown up to the 320×240 preview.                                                                                                                 | minor    | f64a841  |
| 5   | Calls      | Opening a channel without a call answered 404, which the browser logs as a failed request on every channel.                                                                                   | minor    | 2e46f27  |
| 6   | Tests      | The whole-stack reset empties people and channels but keeps workspaces: settings one test leaves on the default workspace (a welcome window) can stop the next ones.                          | minor    | QA flows |

Finding 6 is in the QA flows, not in Cenacle: the API flows put the default workspace's
settings back when they end.

## Coverage

The chat server wrote every request to its access log during the run; each request was
matched to its operation in the OpenAPI description. The whole suite reached 305 operations;
the two it missed (marking a channel unread, turning the web app off) were added to the API
flows and ran in the next run of them.

| Operations                                        | Count |
| ------------------------------------------------- | ----- |
| In the API                                        | 319   |
| Succeeded on the real stack                       | 307   |
| Called, refused as they should be                 | 6     |
| Not called from a browser (server-to-server only) | 6     |
| Server errors (5xx)                               | 1     |

- The one 5xx is 502 from a message button whose bot cannot be reached: the answer the API
  documents for that case.
- Refused as they should be: push subscriptions
  (push is off on the test stack), a desktop sign-in code that does not exist, a dialog and
  federation offers that do not exist.
- Server-to-server only: federation connections, shared channels and `v1/events`, which need
  a second server.
- Every operation of the last two groups runs successfully in the Go integration tests with
  two real servers or a fake bot: `internal/app/federation_test.go`,
  `federation_delivery_test.go`, `federation_controls_test.go`, `interactivity_test.go`,
  `push_delivery_test.go` and `internal/auth/desktop_test.go`.

## What was done

### Real stack, in the browser (33 journeys, all passed)

The chat server, Cenacle ID, the web app and the media server as processes against
PostgreSQL, Valkey and Garage. The suite ran with calls on and AI pointed at a small local
model.

- **Whole-stack journeys:**
  - sign-in and sign-out
  - two-step verification and its reset
  - live chat over a reconnect
  - announcements, private channels, edits and Undo
  - workspaces by invitation
  - direct conversations with typing and presence
  - "Sign out everywhere"
  - Markdown, mentions and reactions
  - Jira cards
  - slash commands, reminders and messages sent later
  - files through the object store
- **Roles:** only the instance administrator reaches the administration; a member promoted
  to admin and demoted again; a guest through a guest link.
- **Calls:** the real media server forwards camera and audio, reconnects without duplicates
  and writes the outcome; a direct call that rings, is declined, then accepted; three people
  with one shared screen.
- **Each role's walk:**
  - the administrator and a member, in English and Turkish, light and dark: every view,
    menu, window and setting, with screenshots and the console watched
  - a member on a phone
  - a guest
- **A new team's day in 16 steps:** invite, channels, threads, mentions, files, search,
  reminders and a call.
- **AI with a real model:** the notice before the first use, a channel summary, rewriting a
  draft, asking a question.
- **14 features one by one:** canvases, lists moved without dragging, events, playbooks,
  image viewer, search inside files and canvases, a voice message, notification settings,
  retention and legal holds, the audit log, a personal data download, a bot with a token and
  an incoming webhook, an encrypted channel the server cannot read, and a report to the
  moderators.
- **API flows for every operation the walks do not reach.** Each one is created, used,
  changed and removed:
  - categories, channel members and roles, archive
  - reactions, read receipts, pins, forwards, link previews, polls, burn-on-read in a
    direct conversation, saved items, threads, presence, notification levels
  - bots with tokens rotated, commands, event subscriptions and redelivery, and interactions
  - custom emoji and stickers, forms, and workflows with a form, an approval and a webhook
  - moderation reports, timeouts, automod, spillage
  - compliance archives and exports, member attributes, legal holds
  - the system console's policies, audit export and stream, the banner and terms, interface
    texts, encryption escrow, and erasing a person
  - workspace permissions, icon, appearance, invitations, directory groups, welcome and
    mention groups
  - personal status, picture, appearance, sounds, fonts and sessions
  - device keys, recovery and backups
  - turning the web app off from the console: browsers are turned away and learn it from
    `/api/meta`

### Operations, with the documentation only (Compose, the images built from `main`)

- **Fresh install:** every service healthy. The first account set up two-step verification
  in the browser and posted a message and a file. Cenacle ID runs with
  `--no-turbo-fast-api-calls`.
- **Backup and restore:** `backup-daily.sh`, its checksums verified, then a restore into a
  new stack (settings, both databases, the files through rclone). The person was still
  signed in, and the message and the file were there.
- **Upgrade:** 0.99.4 installed with data, then upgraded by the guide (new `deploy/compose`
  files, `.env.prod` and secrets kept), with 64 migrations applied. The same session, the
  message and the file held, and posting worked.
- **Rollback** to 0.99.4 with its own files on the upgraded databases: all held again.
- The shared host's other containers were not touched.

### Automated suites

`make lint test`, the web journeys in Chromium (fine and coarse pointers), Go against
PostgreSQL and Valkey, and the release pipeline on `main`.

## Not tested here

- The desktop app's whole-stack journey (it needs a display; it ran in 0.99.5's round) and
  its Windows installers.
- Real certificates from a public ACME service on ports 80 and 443 (another service uses
  them here; Pebble stood in, in 0.99.5's round).
