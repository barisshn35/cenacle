# Assistants over MCP (optional)

People can connect AI assistants that speak the Model Context Protocol (desktop AI apps,
editors, agents) to Cenacle: the assistant reads what the person reads and may leave drafts
for them to send (ADR 0056). It is off until an administrator allows it.

## Allow it

System console → Security → **Let people connect AI assistants**. Turning it off later stops
every assistant token at once (they work again if it is turned back on and they have not
expired).

## What people do

Settings → Assistants: a person names a token, chooses whether the assistant may leave drafts,
and how long the token works (7, 30 or 90 days). The token (`cnp_…`) is shown once; the
assistant uses it as a bearer token at the MCP address shown there,
`https://<your chat address>/api/mcp` (streamable HTTP). A configuration entry, for clients that
take one:

```json
{
  "mcpServers": {
    "cenacle": {
      "type": "http",
      "url": "https://chat.example.com/api/mcp",
      "headers": { "Authorization": "Bearer cnp_…" }
    }
  }
}
```

Each person has at most 10 working tokens, sees when each was last used and revokes them.
Making and revoking tokens, and the policy, are in the audit log
(`assistant.token_created`, `assistant.token_revoked`, `assistant.policy_changed`).

## What an assistant can do

| Tool              | What it does                                                             |
| ----------------- | ------------------------------------------------------------------------ |
| `list_channels`   | The channels and conversations the person is in                          |
| `read_messages`   | A channel's latest messages (threads' first messages, with reply counts) |
| `read_thread`     | A thread's messages                                                      |
| `search_messages` | Search by words in the person's channels                                 |
| `list_meetings`   | The person's meetings and the events they go to                          |
| `draft_message`   | With the draft scope: a draft in a channel's or thread's message box     |

An assistant never sends, edits or deletes a message or reacts: a draft waits above the
message box until the person puts it in the box (to edit and send) or throws it away.
Encrypted channels and burn-after-reading messages are never shared. A token reaches only
`/api/mcp`, at most 60 requests a minute.

What an assistant reads goes to its own provider; the settings page says so before a token
is made. If your organization does not want that, leave assistants off.
