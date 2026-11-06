# 0049. Erasure and ended sessions across the chat and Cenacle ID (1.0)

- Status: accepted
- Date: 2026-11-04

## Context

A review of data subject requests before 1.0 found that erasing a person left their profile
picture, fonts and sounds in the database; that open apps and the servers a channel is
shared with kept their messages, because erasure sent no `message.deleted`; that messages a
legal hold kept stayed visible under "Deleted user" and were never purged after the hold;
that the data download left out much of what the chat keeps; that Cenacle ID could neither
export nor delete an account; and that resetting two-step verification at Cenacle ID left
the person's chat sessions open, so a stolen device stayed signed in to the chat.

## Decisions

1. **Erasure is one transaction in the chat** and removes the profile picture with the
   fonts and sounds the person uploaded. The columns that point at a picture are indexed
   (migration 00062): without them every deleted picture read those tables whole for its
   foreign keys. Pictures nothing shows are removed once (00063), apart from 00062 so its
   short index locks are not held meanwhile.
2. **Every erased message is announced at once**: one statement writes `message.deleted`
   to the outbox, to the subscribed bots of each message's channel and to the servers the
   channel is shared with (not back to the server a federated person came from), the same
   events `emit` writes one by one.
3. **Held messages are hidden, not kept visible**: erasure marks them deleted like the
   rest; they keep their text and edits for eDiscovery (which exports deleted messages), and
   the existing purge removes them once no hold keeps them.
4. **The data download lists what the chat keeps**, with file bytes (base64, a mebibyte per
   line) and the person's picture, fonts and sounds; secrets (token and password hashes,
   signing, push and end-to-end keys) stay out by name.
5. **Cenacle ID exports and deletes accounts.** Deleting ends sessions, removes the row
   (the rest cascades), blanks the IP addresses and personal details of the person's own
   audit events and keeps a tombstone (`deleted_accounts`), which the directory feed reports
   as a disabled account so the chat deactivates the person.
6. **Ended sessions reach the chat through the directory feed**: Cenacle ID records when it
   ended a person's sessions (`sessions_ended_at`, a two-step reset, a deactivation, a
   deletion), and the chat deletes the sessions it made before then within a minute.
   Requiring two-step verification for everyone does not, so a policy change does not sign
   everyone out of the chat.

## Consequences

- An erasure of someone with many messages writes as many outbox events and bot and
  federation deliveries in one transaction.
- A person still listed by a directory or identity provider comes back as a new account at
  their next synchronization or sign-in; the delete page says so.
- Tombstones are never pruned (they are small).
- The chat and Cenacle ID compare times of two databases: sessions made within the clock
  difference of a reset may survive it or end with it.
