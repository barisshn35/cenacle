# 0009. Direct messages, unread counts, presence and typing (v0.7)

- Status: accepted
- Date: 2026-10-21

## Context

v0.7 adds what makes a chat feel alive: conversations between people, knowing what is new,
who is around and who is typing. The kickoff fixes the shape: DMs are channels of kind
`dm`, typing is short-lived pub/sub that is never stored, presence is a Valkey counter with
heartbeats.

## Decisions

1. **Conversations are channels.** Kinds `direct` (two people) and `group` (3 to 9 people),
   always private, never default. Messages, edits, deletions and live delivery work as in
   channels without new code paths. A conversation is keyed by its people: the name column
   holds `direct:<id>:<id>` (sorted ids) or `group:<sha256 of sorted ids>`, unique per
   workspace, so the same people always get the same conversation
   (`POST /api/workspaces/{id}/conversations` answers 200 for an existing one, 201 for a new
   one). Clients show the other people's names instead. Channel names cannot start with
   `direct:` or `group:`.
2. **Only their people see conversations.** Workspace owners and admins, who see private
   channels, do not see conversations; nobody manages them (no renaming, archiving,
   categories, member changes or removing others' messages). The directory lists channels
   only. The people of a group are fixed; adding someone means a new conversation.
3. **Unread is a read position.** `channel_members.last_read_id` is the newest message a
   member has read (uuidv7 ids sort by time). It only moves forward. Unread counts are
   messages of others after it, counted up to 100 in the channel list query (clients show
   "99+"). Sending marks your own message read. Joining starts reading at the newest
   message (a trigger fills `last_read_id` on insert), so history is not unread; the
   migration does the same for existing members.
4. **Reading.** The web app marks a channel read when the newest message is on screen in a
   visible tab (`POST /api/channels/{id}/read`); the reader's other devices get
   `channel.read`. A "New messages" line marks where reading stood when the channel opened.
   Badges keep their meaning (glossary): numbers for conversations, bold text and a dot for
   channels; the workspace rail marks workspaces with unread messages.
5. **Short-lived events.** Typing and presence go over Valkey pub/sub (`cenacle:ephemeral`)
   to every instance, then to WebSockets as `op: "ephemeral"` frames: no id, never stored,
   never resumed or replayed, dropped for a client whose queue is half full (they are not
   worth a reconnect). `typing` reaches the channel's other members; the server lets one
   notice per user and channel through every 2 s, clients send at most every 3 s and show
   a notice for 6 s or until that person's message arrives.
6. **Presence.** Each WebSocket connection is a member of a sorted set per user with an
   expiry (heartbeat every 20 s, 60 s TTL); a second sorted set holds online users. The
   first connection publishes `online`, the last one closing (or a sweeper finding expired
   connections, e.g. after an instance crashed) publishes `offline`; removing the user
   from the online set decides which instance announces it. Users choose `away` or `dnd`
   (`PUT /api/presence`), kept in a hash while they are connected. Changes go to the
   people of the user's workspaces (`presence.changed` carries the workspace ids);
   `GET /api/workspaces/{id}/presence` gives the current state. Presence shows color and
   shape.

## Consequences

- The `Channel` schema gains `unread_count`, `last_read_id` and `participants`; `kind`
  gains `direct` and `group`.
- Presence needs no database writes; a Valkey restart shows everyone offline until their
  next heartbeat (at most 20 s).
- Mentions (v0.9) will count separately from unread messages.
