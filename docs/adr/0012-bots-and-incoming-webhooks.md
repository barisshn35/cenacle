# 0012. Bots, scoped tokens and incoming webhooks; Jira (v0.10)

- Status: accepted
- Date: 2026-10-21

## Context

Integrations run outside Cenacle (no plugin system): programs act as bots through the
API, and other systems push events into channels. v0.10 lays the foundation and connects
Jira; slash commands, outgoing event subscriptions and SSRF-protected egress follow in
v0.11.

## Decisions

1. **A bot is a user** that never signs in (`auth_service = 'bot'`, `is_bot`), owned by one
   workspace (a member of it), with metadata in `bots`. Its messages go through the same
   path as people's (mentions, outbox, events) and carry `author.is_bot`; people lists
   mark bots. Bots are not added to channels for everyone or to the default workspace
   automatically: they are added where they work, like people.
2. **Workspace owners and admins manage bots**: create, rename, describe, disable and
   enable (S2: tokens and webhooks stop until enabled). Bots are not deleted, so their
   messages keep an author.
3. **Tokens** are random (`cnb_` + 256 bits), stored as SHA-256, shown once, with scopes
   (`messages:read`, `messages:write`) and an optional expiry. Revoking is an S3 action.
   Bot tokens reach only the bot API (list its channels, read and send messages, react),
   enforced by one middleware with an allowlist and the scope each route needs; anything
   else answers `403 bot_not_allowed`. Overlap during rotation: create the new token,
   switch, then revoke the old one.
4. **Incoming webhooks** are secret URLs (`/api/hooks/cnh_…`, 256 bits, stored as SHA-256,
   shown once) that post into one channel as their bot; creating one adds the bot to the
   channel. `generic` takes `{"text", "attachments"}`; `jira` takes Jira's webhook events.
   Webhooks are rate-limited like people, bodies are limited to 1 MiB, and a deleted
   webhook or disabled bot answers 404.
5. **Jira** (Cloud and Data Center send the same payload): issue created, updated (only
   status, assignee, priority and summary changes are posted), deleted, and comment
   created become cards with the issue link (built from the issue's REST address, http(s)
   only), status, priority and assignee. Other events answer 200 and post nothing, so
   Jira does not retry them.
6. Every bot, token and webhook change is in the workspace audit log.

## Consequences

- `Person` and `Author` may carry `is_bot`.
- Outgoing requests (slash commands, subscriptions) do not exist yet, so there is no
  egress to protect; v0.11 adds them with SSRF protection.
