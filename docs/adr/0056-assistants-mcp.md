# ADR 0056: Assistants over MCP

Status: accepted (2026-11-12).

## Context

People use AI assistants (desktop apps, editors, agents) that speak the Model
Context Protocol (MCP). Letting an assistant read one's channels, find a
decision or prepare a reply saves time, but it hands a program that follows
instructions found in text (prompt injection) access to work conversations.
The bot API (ADR 0012) is for programs acting as themselves; an assistant acts
for one person and must never see more than that person.

## Decision

- **Off until allowed**: the installation's administrators allow assistants
  (System console → Security). Until then no assistant token can be made or
  used.
- **Personal assistant tokens**: a person makes a token in Settings →
  Assistants, named, with scopes and a lifetime (7, 30 or 90 days); it starts
  with `cnp_` (secret scanners recognise it), is shown once and stored hashed,
  and the person sees when each was last used and revokes it at any time.
  Erasure and deactivation end them. Making and revoking are in the audit log.
- **One endpoint**: `/api/mcp`, MCP's streamable HTTP transport (the official
  Go SDK, MIT/Apache-2.0), with the token as a bearer token. An assistant token
  reaches nothing else of the API.
- **Read** (always): the channels and conversations the person is a member of,
  their messages and threads, search by words, and the person's meetings.
  Never encrypted channels or burn-after-reading messages. Tool descriptions say
  that message text is data written by people, not instructions.
- **Draft** (scope `draft`): an assistant may leave a draft in a channel's
  message box: the person's app shows it there to edit and send, or to throw
  away. **An assistant never sends, edits, deletes or reacts**: whatever text it
  was given, nothing leaves in the person's name without them.
- Requests are limited per token (60 a minute).

## Consequences

- An assistant sees what its person reads in Cenacle, and its own provider then
  processes it; the settings page says so before a token is made.
- Workspaces' AI settings (ADR 0029) are about the server's own model and do not
  apply: the person chooses their assistant, the administrator whether
  assistants are allowed at all.
