# Integrations

Integrations run outside Cenacle and talk to it over HTTP. Workspace owners and admins
manage them in the app: workspace menu → **Integrations**.

## Bots and tokens

A bot is a member of the workspace that programs act as. Create a bot, add it to the
channels it works in (channel details → Add people), and create a token:

- `messages:write` — send messages and react;
- `messages:read` — list the bot's channels and read their messages.

The token (`cnb_…`) is shown once. Send it as `Authorization: Bearer <token>`:

```sh
curl -X POST https://chat.example.com/api/channels/<channel-id>/messages \
  -H "Authorization: Bearer $CENACLE_BOT_TOKEN" -H "Content-Type: application/json" \
  -d '{"body": "Deploy **v1.2** finished", "nonce": "deploy-1842"}'
```

`nonce` (8–64 characters) makes retries safe: the same nonce never posts twice. Messages
are Markdown; `<@user-id>` mentions a member. Up to five cards can go with a message:

```json
{
  "body": "",
  "nonce": "alert-77",
  "attachments": [
    {
      "title": "Disk 90% full on db-1",
      "title_link": "https://grafana.example.com/d/abc",
      "text": "Free space: **9 GB**",
      "color": "warning",
      "fields": [{ "title": "Host", "value": "db-1", "short": true }]
    }
  ]
}
```

Colors are `neutral`, `info`, `success`, `warning` and `danger`; say the meaning in the text
too. To rotate a token, create the new one, switch the program over, then revoke the old.

## Incoming webhooks

A webhook is a secret address that posts into one channel as its bot, for systems that can
only call a URL. Create it under the bot; the address is shown once.

A **messages (JSON)** webhook takes the same text and cards as above, without a nonce:

```sh
curl -X POST "$WEBHOOK_URL" -H "Content-Type: application/json" \
  -d '{"text": "Backup finished in 4 min"}'
```

Answers: `200` posted, `400` the body is not valid, `404` unknown address or disabled bot,
`429` too many messages (see `Retry-After`).

## Jira

1. In Cenacle: Integrations → New bot (e.g. "Jira") → Incoming webhooks: pick the channel
   and **Jira events**, create, and copy the address.
2. In Jira (administrator): **System → WebHooks → Create a WebHook**. Paste the address as
   the URL. Events: _Issue created, updated, deleted_ and _Comment created_. Optionally
   limit them with JQL (e.g. `project = CEN`).

Cenacle posts a card per event: created and deleted issues, comments, and updates that
change the status, assignee, priority or summary. Other events are accepted and ignored.
Jira Cloud and Data Center send the same events; Data Center must be able to reach the
Cenacle address.
