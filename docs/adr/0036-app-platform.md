# 0036. Interactive messages, SDKs and more integrations (v0.33)

- Status: accepted
- Date: 2026-10-24

## Context

Items M9, I4 and I3 of the 2026-10-23 plan. Cenacle has no plugins: apps run in their own
processes (ADR 0012, 0014). To feel native they need interactive cards and forms, and
writing them should not mean reimplementing the protocol; teams also expect the common
integrations out of the box.

## Decisions

1. **Interactions go to one address per bot** (`bots.interactions_url`, with its own
   signing secret, shown once). A card holds up to five buttons and menus; pressing one
   sends the bot a signed `action` request with who, where and which message. The bot
   answers synchronously (10 s) with a note for the person, a replacement of the message's
   text or cards (not marked edited — it is the app's own message), and/or a dialog.
2. **Dialogs are kept on the server** (`dialogs`, 15 minutes) rather than handed to the
   client as an opaque token: Cenacle checks the submitted values against the fields the
   bot declared (required, length, options, dates) before the bot sees them, and only the
   person the dialog was opened for can submit it. The bot can still refuse values
   (`errors`), which keeps the dialog open. Slash command answers can open dialogs too.
3. **SDKs for Go and Python** wrap the API client and the signed handlers, with only the
   standard library, and are under the Apache License 2.0 so bots of any license can use
   them; the server stays AGPL. Their signature code is tested against a vector from the
   server's own signing.
4. **Integrations**: GitHub as another webhook kind (the event comes in a header); e-mail
   into a channel as a webhook that takes RFC 5322 text from the operator's mail server —
   no SMTP or IMAP in Cenacle, so no port to open and no mail library — and feeds (RSS,
   Atom) read by a job through the SSRF-guarded egress client, posted by the workspace's
   Cenacle bot, managed with a built-in `/feed` command.

## Consequences

- Two migrations (`00032`, `00033`), reversible; rolling back drops GitHub and e-mail
  webhooks and feeds.
- A bot that answers slowly or wrongly shows the person "The app did not answer"; nothing
  is retried.
