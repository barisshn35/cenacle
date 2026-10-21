# 0010. Two-step verification, session management, back-channel logout and audit log (v0.8)

- Status: accepted
- Date: 2026-10-21

## Context

v0.8 makes accounts harder to take over and gives users and owners control: a second
factor at Cenacle ID, a view of signed-in devices with "sign out everywhere" (an S3 action
in the UX plan), sign-outs at Cenacle ID that reach the chat server, and an audit log of
security-relevant actions.

## Decisions

1. **TOTP at Cenacle ID** (RFC 6238, 6 digits, 30 s, `otplib`). Secrets are encrypted with
   `IDP_KEY_ENCRYPTION_KEY` (AES-256-GCM, bound to the user id), so a database dump alone
   does not reveal them. A code is accepted from the step before to the step after now,
   and only once: the last accepted time step is stored and later codes must be newer.
   Ten one-time **recovery codes** (50 bits each, stored as SHA-256) are shown once.
2. **The second step is bound to the password check.** After a correct password, a
   challenge (bound to the OIDC interaction, or random for the account pages) allows 5
   attempts within 5 minutes; then sign-in starts over. Errors say why a code may fail
   (30-second codes, once each, device time), how many attempts remain and that a recovery
   code works too; the code field allows pasting and uses `autocomplete="one-time-code"`
   (WCAG 3.3.8).
3. **Account pages** (`/account` at Cenacle ID) with their own short session (30 minutes,
   HMAC-signed cookie, `SameSite=Strict`, path `/account`): turn two-step verification on
   (QR code and typed key) and off, create new recovery codes (both need a current code)
   and see recent activity. The chat app links there from its settings (`account_url` in
   the session); a return link goes back only to registered app origins.
4. **Audit log at Cenacle ID**: sign-ins, failures, second-step failures, recovery code
   use and two-step changes, with address and time.
5. **Sessions in the chat server**: users list their devices (browser and system from the
   user agent, address, last use) and end one or all, optionally keeping the current one.
   Ending sessions publishes a short-lived notice so the user's open connections check
   their session at once instead of at the next minute's check.
6. **Back-channel logout** (OpenID Connect Back-Channel Logout 1.0). Clients register a
   `backchannel_logout_uri`; chat sessions remember the ID token's `sid`. A logout token is
   verified like an ID token (signature, issuer, audience, expiry) plus its own rules
   (logout event, no nonce, subject and `jti`; each `jti` once) and ends the sessions of
   that sign-in, or all of the subject's sessions when it names no `sid`. oidc-provider
   refuses to call private and loopback addresses (SSRF protection); the registered
   back-channel addresses are operator configuration and usually internal
   (`http://server:8180`), so exactly those URLs are exempt.
7. **Audit log in the chat server**: workspace creation and renaming, role changes,
   removals and leaving, invitations (created, revoked, accepted), channel creation,
   renaming and visibility changes, archiving, member and manager changes, and messages
   removed by managers (moderation); sessions ended by the user or by Cenacle ID. Owners
   and admins read their workspace's log (`GET /api/workspaces/{id}/audit`, cursor
   paging); the admin panel (v0.14) will show it. Writing an event never fails the action.

## Consequences

- ID tokens carry `sid`; `amr`, `acr` and `auth_time` are available on request.
- Existing installations add `backchannel_logout_uri` to their clients file (see the
  upgrade notes); without it, signing out at Cenacle ID does not end chat sessions.
- Two-step verification is opt-in per user; requiring it for a workspace or the instance is
  a later admin setting.
