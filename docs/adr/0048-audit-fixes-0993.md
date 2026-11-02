# 0048. One way through for posting, removal and live audiences (v0.99.3)

- Status: accepted
- Date: 2026-11-02

## Context

A second source-level security review, of 0.99.2, confirmed 55 findings (19 medium, 36 low,
none critical or high). Four of them were fixes of 0.99.2 that a side path still went
around. Most of the others had the same shape: a rule was enforced where the main path
decides, but another path to the same effect did not ask it. Examples are scheduled messages,
federated messages, notices, workflow variables and command answers skipping the posting
rules; queued bot and federation deliveries, workflow runs, reminders, archive files and the
resume stream keeping a removed message's text; and open connections keeping a role their
user no longer had. Patching each path again would leave the next new path open, so the fixes
put each rule in one place that every path goes through.

## Decision

1. **Posting rules in one gate.** `postingRules` (server/internal/chat/posting.go) decides
   for every way a message is written. It covers read-only announcement channels, member
   timeouts, AutoMod, mentions of everyone and group mentions, and the reply and reaction
   limits. Every caller asks it: sending, scheduling and the scheduled send, federated
   messages, edits and reactions, playbook and event notices, workflow messages, custom
   command answers and bot updates. Slow mode stays a property of a person typing and is not
   applied to messages from federated servers. AutoMod reads text as the client renders it:
   markdown emphasis, character references, invisible characters, and `www.` and
   scheme-relative links.
2. **Removal follows the message id.** Queued bot deliveries, queued federation events and
   workflow runs record the id of the message they copy (chat migrations 00056 and 00057).
   Deleting, purging, retention, erasure and spillage removal drop those copies. Reminders
   and archive days are tied to the message the same way; an archive day is marked stale and
   written again. Before a queued delivery is sent or resent, `delivery_sendable()` checks
   that the bot may still have it. A spillage removal is final and cannot be restored. A
   thread root whose replies are under a legal hold is kept, as deleted, until the hold ends.
3. **Live audiences are the REST audiences.** The WebSocket forwards and replays an event
   only when its user may see it at that moment. The resume stream skips events from before
   the user joined and bodies removed since. Channel creation follows the guest rules.
   Receipts reach only people who share theirs. A directory change to guest takes effect on
   open connections and ends the spillage reviewer role. Guest connections recompute whom
   they may see at most once a second per workspace.
4. **Work one person causes stays theirs.** Web push sends to many endpoints at once, each
   with a timeout. Every message keeps a cursor until all its members are reached. A
   subscription ends with its session, however the session ends. Reactions, edits and other
   member actions have a per-user rate limit. Guest-link password checks share a server-wide
   memory budget. One failing scheduled message, directory feed entry or Cenacle ID
   directory person no longer stops the batch.
5. **Cenacle ID keeps secrets to their target and disables sticky.** Changing a directory's
   server or account, or a provider's issuer or client id, requires the bind password or
   client secret to be entered again. An administrator's disable is stored apart from the
   status a source sets, so a directory, SCIM or sign-in cannot clear it. Failed attempts
   are recorded before they are counted (Cenacle ID migration 0013). Ending a person's
   sessions also ends their account-page sign-in. Accounts of a provider that is turned off
   cannot sign in with any factor.
6. **Desktop updates are signed by the publisher.** The app installs an update only when its
   `latest*.yml` carries a valid Ed25519 signature of a release key built into the app
   (`desktop/src/update-keys.ts`). The paired server only hosts the files. This replaces the
   trust in the server of [ADR 0033](0033-desktop-app.md) item 8. CI signs the update files
   with the protected file variable `DESKTOP_UPDATE_KEY`.
7. **Browser-held secrets belong to one person and session.** Passphrase channel keys,
   decrypted texts and MLS state are stored under their user and removed whenever the
   session ends, not only on Sign out. MLS authorship comes from the authenticated MLS sender.
   File responses are revalidated, and the desktop cache is cleared on sign-out.

## Consequences

- A new way to post, copy or deliver a message must go through `postingRules` and record
  the message id. Tests in `server/internal/app/postingrules_test.go`,
  `removalcopies_test.go` and `delivery_copies_test.go` cover the existing ways.
- Some behaviour admins see changes; the [upgrade notes](../upgrade/README.md) list it. For
  example, workflow runs and scheduled messages now fail with a reason when the rules refuse
  them, and resending a delivery that is no longer allowed is refused.
- Losing the desktop update key means installed apps must be updated by hand once. To
  rotate it, ship both public keys for one release.
