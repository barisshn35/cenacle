# 0038. SCIM provisioning, session and network policy, federation controls, guest links (v0.35)

- Status: accepted
- Date: 2026-10-24

## Context

Items A-5, S4, S5 and S6 of the 2026-10-23 plan. Accounts of identity providers existed only
after a sign-in and were never deactivated by the provider (ADR 0017). Session lifetimes
were the operator's environment variables only. Federation (ADR 0030) let any workspace
connect to any server and take in everything it sent. People from outside needed a full
account to join a single conversation.

## Decisions

1. **SCIM 2.0 lives in Cenacle ID, per identity provider** (`/scim/v2`, RFC 7643/7644),
   because accounts are Cenacle ID's; the chat follows through the existing directory feed
   (names, addresses, groups, roles, deactivation). Each provider has its own bearer token,
   kept as SHA-256, shown once. Users, Groups, PATCH (including the string booleans some
   providers send) and the `eq` filters providers use are supported; bulk, sorting and
   ETags are not. People provisioned under the provider's own id are bound to its sign-in id
   at their first sign-in by verified e-mail address; people who signed in before are taken
   over. With SCIM on, groups come only from SCIM, so a sign-in without a groups claim does
   not empty them. SCIM DELETE deactivates the account rather than deleting it, so messages
   keep their author.
2. **The session policy is the installation administrators', over the operator's limits:**
   the stricter of `CENACLE_SESSION_*` and the policy applies, so an operator's ceiling
   cannot be lifted from the app. Lifetimes are checked against the session's creation time
   on every request (shortening them ends older sessions), with separate, shorter limits for
   guests. Networks (addresses and CIDR ranges) can be required for signing in and for the
   administration (system console and instance settings); a change that would leave out the
   administrator's own address is refused. The policy is cached for ten seconds per server
   instance.
3. **Federation is open by default** (as in 0.34) and can be limited to listed servers or
   exclude listed ones, matched by host name (and port), with `*.example.com` for
   subdomains. The policy is checked when connecting (both ways), on every incoming batch
   and before sending, so leaving a server out pauses existing connections without deleting
   them. Each connection chooses what it takes in (messages, reactions, edits and
   deletions) and how many requests a minute it accepts (Valkey counter, `429` with
   `Retry-After`). Federation changes and refusals are in the workspace's audit log,
   readable by prefix as its federation activity.
4. **Guest links** let a channel's managers (when the permission scheme gives their role
   `guest_links`, by default admins) invite someone from outside into one channel, until a
   time (at most 30 days) and optionally for a number of people, with a password (Argon2id,
   OWASP parameters). Joining creates a workspace guest without a Cenacle ID account and a
   session that ends with the link; wrong passwords are limited per link and address.
   Revoking a link, or its expiry, deactivates its guests and ends their sessions. Encrypted
   and archived channels have none. The link is shown once and only its SHA-256 is kept.

## Consequences

- Migrations: Cenacle ID `0007_scim`; chat `00036_session_policy`, `00037_federation_controls`,
  `00038_guest_links`; all reversible.
- An administrator who loses access to the administration through the network policy clears
  it in the database (documented in the upgrade notes).
- Guest links need the web app: where it is turned off, guests cannot join.
