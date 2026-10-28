# 0044. Full review and accessibility conformance (v0.41)

- Status: accepted
- Date: 2026-10-25

## Context

After the features of 0.31–0.40, the 2026-10-23 plan gives 0.41 to a review of the whole
product and to item L1: a published accessibility conformance report, which procurement
asks for (European Accessibility Act, EN 301 549).

## Decisions

1. **The review covered five areas separately** (chat handlers; the rest of the server;
   Cenacle ID; the web, desktop and shared packages; deployment, CI and documentation).
   Every finding was traced in the code before it was fixed, and every fix has a test that
   fails without it. Findings that could not be confirmed were recorded, not acted on.
2. **Every way of writing goes through the same rules.** Mention permissions, timeouts and
   AutoMod are one check (`mentionRights`, `timedOut`, `automod`) called when sending,
   editing, forwarding and running commands; channel joins by command follow the rules
   of joining. New ways of writing must call them too.
3. **Encrypted channels get no text the server reads**, whatever the feature: commands
   that carry text, scheduled messages, tabs (also writing in the canvases and lists of
   tabs made before the channel was encrypted), form answers, playbook run names and forum
   titles are refused there by the server (one check, `serverReadable`, in the loaders of
   these writes), and the app sends such text as an encrypted message. Removing what was
   written before stays possible. The sender's user id
   travels inside the encryption (ts-mls does not tell the receiver which member sent a
   message), and an envelope is accepted for one message id only.
4. **Signing out forgets the device.** Encryption keys, group states, decrypted messages,
   passphrase keys, drafts and the push subscription go; the server forgets the device.
   A push subscription belongs to the session that made it, so ending that session any
   other way (another device, sign-out everywhere, the directory, expiry) stops its
   pushes too; the app renews the subscription after a new sign-in.
   History comes to the next device from backups sealed with the recovery key.
5. **S3 uploads are staged.** A POST policy can be used until it expires, so browsers
   upload to `uploads/<id>` and the server copies the object to `files/<id>` (only the
   version it saw, by ETag) when the upload completes; later uploads with the same form
   are never served. Backends whose upload tickets work once (directory, Azure) upload in
   place.
6. **The realtime connection has an application-level beat.** Browsers cannot see
   WebSocket pings, so the server also sends a `ping` frame every heartbeat; the client
   reconnects after two heartbeats of silence. The resume position moves only with
   events or a resync, never with `hello` alone.
7. **Accessibility is reported on the VPAT 2.5 INT template** (WCAG 2.2 A/AA and
   EN 301 549), from automated checks and manual checks written as tests
   (`web/e2e/accessibility.spec.ts`). Results are stated as they are ("partially
   supports" where a gap is known), and the missing screen-reader session is named as the
   main gap rather than assumed.
8. **The message list stays quiet for screen readers.** It is virtualized, so its log
   region would announce older messages as they mount; a separate status region announces
   new messages from others.

## Consequences

- Operators: migrations 00045 (chat) and 0008 (Cenacle ID); directories that relied on
  taking over local accounts by e-mail need their new setting turned on.
- After signing out, a browser joins encrypted channels again as a new device; without a
  recovery key, earlier messages stay unreadable there.
- A full screen-reader evaluation remains to be done before 1.0.
