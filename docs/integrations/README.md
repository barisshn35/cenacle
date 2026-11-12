# Integrations

Integrations run outside Cenacle and talk to it over HTTP. Workspace owners and admins
manage them in the app: workspace menu → **Integrations**. Bots written in Go or Python
can use the [SDKs](../../sdk/README.md), which wrap what follows.

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
are Markdown; `<@user-id>` or `@username` mentions a member (not inside code). Up to five cards can go with a message:

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
too.

A card can carry a small chart, bar or line: up to 24 labels and up to four series with one
number per label. Apps draw it and offer the numbers as a table too, so say what matters in
the card's text as well:

```json
{
  "title": "p95 latency, last 6 hours",
  "chart": {
    "kind": "line",
    "unit": "ms",
    "labels": ["10:00", "11:00", "12:00", "13:00", "14:00", "15:00"],
    "series": [{ "name": "api", "values": [120, 118, 140, 210, 160, 125] }]
  }
}
```

**Live cards.** With `messages:write` a bot replaces the cards of its own message:
`PUT /api/channels/<channel id>/messages/<message id>/attachments` with
`{"attachments": [ … ]}`. The text stays and no edit is recorded; members see the new cards
at once (`message.updated`). Use it for a build's progress or numbers that change.

A bot token reaches only these operations; anything else answers `403` with the code
`bot_not_allowed`:

- `messages:read`: list its channels (`GET /api/channels`), read a channel's messages and
  files, download a file or its thumbnail;
- `messages:write`: send messages, replace the cards of its own messages, add and remove
  reactions, upload files (announce, complete) and delete an upload not yet sent.

Bots cannot edit or delete messages, their own included, whatever role the bot account
holds in the workspace or channel: `PATCH` and `DELETE /api/channels/<id>/messages/<id>`
answer `bot_not_allowed`, and the SDKs have no call for them. To change a card the bot
posted, replace its cards (above) or answer an interaction with `update` (see
[Interactive messages](#interactive-messages)).

Bots, webhooks, commands and workflows cannot write in channels encrypted end to end
(`encrypted_channel`): only their members' apps hold the key.

To rotate a token, choose **Rotate** next to it: a new token with the same name, scopes and
lifetime is created, and the old one keeps working for the overlap you pick (up to a week,
or none). Switch the program over within the overlap.

### Files

A token with `messages:write` can send files, in three steps:

```sh
# 1. Announce the file: you get a form for exactly this size.
curl -s -X POST https://chat.example.com/api/channels/<channel-id>/files \
  -H "Authorization: Bearer $CENACLE_BOT_TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "report.pdf", "size": 48213, "content_type": "application/pdf"}' > upload.json
# 2. Post the file with the form's fields (the file last).
curl -s -X POST "$(jq -r .upload.url upload.json)" \
  $(jq -r '.upload.fields | to_entries[] | "-F \(.key)=\(.value)"' upload.json) \
  -F file=@report.pdf
# 3. Let Cenacle check it, then send it with a message.
curl -s -X POST https://chat.example.com/api/files/$(jq -r .file.id upload.json)/complete \
  -H "Authorization: Bearer $CENACLE_BOT_TOKEN"
curl -s -X POST https://chat.example.com/api/channels/<channel-id>/messages \
  -H "Authorization: Bearer $CENACLE_BOT_TOKEN" -H "Content-Type: application/json" \
  -d "{\"body\": \"Weekly report\", \"nonce\": \"report-42\", \"file_ids\": [\"$(jq -r .file.id upload.json)\"]}"
```

A relative upload URL (`/cenacle-files/`) is on the chat server's address. Files not sent
with a message within a day are removed. With `messages:read`, a bot can read the files of
its channels (`GET /api/files/<id>/content`).

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

## GitLab

1. In Cenacle: create a bot (e.g. "GitLab") → Incoming webhooks → **GitLab events**, pick
   the channel, create, and copy the address.
2. In GitLab: the project or group → **Settings → Webhooks → Add new webhook**. Paste the
   address as the URL and choose _Push_, _Merge request_, _Pipeline_, _Issues_ and
   _Comments_ events.

Cards: pushes (up to five commits), merge requests (opened, merged, closed, approved),
pipelines that succeed, fail or are cancelled, issues and comments. Other events are
accepted and ignored.

## GitHub

1. In Cenacle: create a bot (e.g. "GitHub") → Incoming webhooks → **GitHub events**, pick
   the channel, create, and copy the address.
2. In GitHub: the repository or organisation → **Settings → Webhooks → Add webhook**.
   Paste the address as the _Payload URL_, choose `application/json`, and pick _Pushes_,
   _Pull requests_, _Pull request reviews_, _Issues_, _Issue comments_, _Workflow runs_ and
   _Releases_ (or "Send me everything": the rest is accepted and ignored).

Cards: pushes (up to five commits), pull requests opened, reopened, ready for review,
merged or closed, reviews (approved, changes requested), issues opened or closed,
comments, finished workflow runs and published releases. The address is the secret; a
GitHub webhook secret is not needed.

## E-mail into a channel

An **E-mails** webhook posts each e-mail it receives as a card: sender, subject, text (the
plain-text part, or the HTML one as text) and the names of attachments, up to 10 MiB per
e-mail. Cenacle receives no mail itself: your mail server hands e-mails over. With Postfix,
for an address such as `ops-channel@example.com`:

```text
# /etc/aliases
ops-channel: "|/usr/bin/curl -fsS --data-binary @- https://chat.example.com/api/hooks/cnh_…"
```

(run `newaliases` afterwards). With a mailbox elsewhere, `fetchmail` with an `mda` running
the same `curl` works the same way.

## Feeds (RSS, Atom)

A channel follows a feed with a built-in command (its managers):

- `/feed subscribe https://example.com/releases.atom`
- `/feed list` (anyone in the channel)
- `/feed unsubscribe https://example.com/releases.atom`

Cenacle reads each feed every 15 minutes (less often while it fails, up to every 8 hours)
and posts new items as cards from the workspace's **Cenacle** bot, at most five at a time.
Items the feed had when it was added are not posted. A channel follows up to 20 feeds;
feeds are read under the same network rules as bots (`CENACLE_EGRESS_ALLOW` for addresses
inside your network).

## Alertmanager

1. In Cenacle: create a bot (e.g. "Alerts") → Incoming webhooks → **Alertmanager alerts**.
2. In `alertmanager.yml`, add a receiver and route alerts to it:

```yaml
receivers:
  - name: cenacle
    webhook_configs:
      - url: https://chat.example.com/api/hooks/cnh_…
        send_resolved: true
```

Each notification becomes one card: FIRING or RESOLVED with the alert name, colored by
`severity` (`critical` → danger, `warning` → warning, resolved → success), the summary or
description, labels that differ between alerts, and a link to the generator.

## Workflows

Workspace owners and admins build workflows without code: **Workflows** at the top of the sidebar.
A workflow has a trigger and steps; people start manual workflows and fill in forms from
the ⚡ button of the composer. Steps run as the workspace's **Cenacle** bot.

A **webhook** workflow has a secret address (shown once; **New address** replaces it).
The JSON object's top-level fields become `{{webhook.<field>}}` variables:

```sh
curl -X POST "$WORKFLOW_URL" -H "Content-Type: application/json" \
  -d '{"service": "api", "state": "down"}'
```

It answers `202` (started), `400` (not a JSON object), `404` (unknown address or turned
off) or `429` (more than 120 runs in the last hour).

A **Send to a web address** step posts
`{"workflow": "…", "run_id": "…", "variables": {…}}`, signed with the workflow's secret
exactly like the requests below.

## Requests from Cenacle

Slash commands and event subscriptions make Cenacle call a bot's server. Every request:

- is a `POST` with a JSON body, `User-Agent: Cenacle` and `Content-Type: application/json`;
- is signed: `X-Cenacle-Signature: t=<unix seconds>,v1=<hex>` where `<hex>` is
  HMAC-SHA256 with the command's or subscription's secret (`cns_…`, shown once) over
  `<t>.<raw body>`;
- times out after 10 seconds; redirects are not followed; answers over 1 MiB are refused.

Check the signature on the raw body before parsing it, in constant time, and reject
timestamps older than five minutes:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, header, rawBody) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const age = Math.abs(Date.now() / 1000 - Number(parts.t));
  const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  return (
    age < 300 &&
    expected.length === parts.v1?.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1))
  );
}
```

```python
import hashlib, hmac, time

def verify(secret: str, header: str, raw_body: bytes) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    expected = hmac.new(secret.encode(), parts["t"].encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return abs(time.time() - int(parts["t"])) < 300 and hmac.compare_digest(expected, parts.get("v1", ""))
```

**Network.** Cenacle only calls addresses on the internet over `https`. A bot inside your
network (private, loopback or link-local addresses) must be allowed by the operator with
`CENACLE_EGRESS_ALLOW` (comma-separated networks, e.g. `10.20.0.0/16`). This keeps a
command or subscription address from being used to reach internal services.

## Slash commands

People type `/` in the composer to see the commands of the workspace. Built in:

| Command   | What it does                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------- |
| `/remind` | `/remind me in 10m stand up`, `at 15:30 …`, `tomorrow …`, `10 dk sonra …`, `yarın 9:00`                  |
| `/join`   | `/join ops`: join a public channel                                                                       |
| `/leave`  | leave the current channel                                                                                |
| `/topic`  | set the channel topic (its managers)                                                                     |
| `/me`     | `/me is deploying` posts _is deploying_                                                                  |
| `/shrug`  | adds ¯\\\_(ツ)\_/¯                                                                                       |
| `/feed`   | `/feed subscribe <address>`, `/feed unsubscribe <address>` or `/feed list`: see [Feeds](#feeds-rss-atom) |

Reminders come from the **Cenacle** bot in a direct conversation at the time asked, in
the time zone of the person's browser. Scheduled messages and reminders are listed (and
cancelled) under **Send later** next to the send button. To send a message that starts with
a slash, begin it with `//`.

A bot adds its own command under Integrations → the bot → **Commands**: the command (e.g.
`deploy`, unique in the workspace), the request address, a description and an argument
hint. When someone runs `/deploy api prod`, Cenacle sends:

```json
{
  "command": "/deploy",
  "text": "api prod",
  "user_id": "…",
  "user_name": "Ayşe Yılmaz",
  "channel_id": "…",
  "channel_name": "ops",
  "workspace_id": "…"
}
```

Answer `200` with:

```json
{ "response_type": "ephemeral", "text": "Deploying **api** to prod…", "attachments": [] }
```

`ephemeral` (the default) is shown only to the person who ran the command;
`in_channel` posts the text and cards in the channel as the bot. An empty body shows
nothing. Any other status, a timeout or invalid JSON shows the person an error. For long
work, answer at once and post the result later with a bot token.

## Event subscriptions

Under Integrations → the bot → **Events**, subscribe an address to events in the channels
the bot is a member of: `message.created`, `message.updated`, `message.deleted`,
`reaction.added`, `reaction.removed`. The bot's own messages and reactions are not sent to
it.

```json
{
  "id": "01a1…",
  "type": "message.created",
  "created_at": "2026-10-22T09:30:00Z",
  "data": { "id": "…", "channel_id": "…", "body": "…", "author": { "id": "…" } }
}
```

`data` is the message (for `message.deleted`: `id` and `channel_id`; for reactions:
`channel_id`, `message_id`, `emoji`, `user_id`). Headers `X-Cenacle-Event` and
`X-Cenacle-Delivery` repeat the type and the delivery id.

Answer any `2xx` quickly. Otherwise Cenacle tries again after 30 s, 1 min, 2 min … up to an
hour between attempts, eight attempts in all; then the delivery is marked failed. The
**Deliveries** list of a subscription shows each delivery's state, last HTTP status and
error, and can send a delivery again. Deliveries are kept for 14 days. A delivery can
arrive more than once: use its id to ignore repeats.

What a bot may no longer get is not sent: once the bot is disabled, the subscription is
removed or the bot leaves the channel, its waiting deliveries fail and none is sent again.
Deleting a message (or removing it as spillage, or erasing its author) also takes the
deliveries carrying it out of the list, so its text is never sent afterwards; the
`message.deleted` delivery still goes.

## Interactive messages

A bot's cards can carry up to five **buttons** and **menus**, and a bot can open a
**dialog** (a form) for the person who used them. Set the bot's interactions address
under Integrations → the bot → **Interactions**; the signing secret (`cns_…`) is shown once
and requests are signed as above.

A card with actions (posted with the bot's token, a webhook or a command answer):

```json
{
  "title": "Release 1.4",
  "actions": [
    { "id": "approve", "type": "button", "text": "Approve", "style": "primary", "value": "1.4" },
    {
      "id": "env",
      "type": "select",
      "text": "Environment",
      "options": [{ "text": "Production", "value": "prod" }]
    }
  ]
}
```

`id` is 1–64 lowercase letters, digits, `-` or `_`; `style` is `default`, `primary` or
`danger`; a menu has up to 25 options. When someone presses a button or picks an option,
the bot receives:

```json
{
  "type": "action",
  "action_id": "approve",
  "value": "1.4",
  "message_id": "…",
  "attachment": 0,
  "user": { "id": "…", "name": "Ayşe Yılmaz" },
  "channel": { "id": "…", "name": "releases" },
  "workspace_id": "…"
}
```

It answers within 10 seconds with any of:

```json
{
  "text": "Approved.",
  "update": { "text": "Release 1.4", "attachments": [ … ] },
  "dialog": {
    "title": "Deploy 1.4",
    "submit_label": "Deploy",
    "state": "anything the bot wants back",
    "elements": [
      { "name": "reason", "label": "Reason", "type": "text" },
      { "name": "when", "label": "When", "type": "date", "optional": true },
      { "name": "env", "label": "Where", "type": "select", "options": [ … ] },
      { "name": "notify", "label": "Tell the team", "type": "checkbox" }
    ]
  }
}
```

- `text` is shown to the person only.
- `update` replaces the message's text and/or cards (not marked edited); leave out what
  stays.
- `dialog` opens a form: up to 10 fields of type `text`, `textarea`, `select`, `checkbox` or
  `date`, with `placeholder`, `help`, `value`, `optional` and `max_length`. A slash command
  answer can carry a `dialog` too.

Cenacle checks the fields (required ones, lengths, menu options, dates as `YYYY-MM-DD`)
before the bot receives:

```json
{
  "type": "dialog_submission",
  "dialog_id": "…",
  "values": { "reason": "hotfix", "when": "", "env": "prod", "notify": true },
  "state": "anything the bot wants back",
  "message_id": "…",
  "user": { … },
  "channel": { … },
  "workspace_id": "…"
}
```

Answer `{"errors": {"reason": "Say why."}}` to keep the dialog open with those messages, or
`{}` / `{"text": …, "update": …}` to close it. Dialogs expire after 15 minutes. A bot that
does not answer, answers an error or invalid JSON shows the person "The app did not answer".
