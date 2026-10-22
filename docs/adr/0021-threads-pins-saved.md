# 0021. Threads, pins, saved messages and activity (v0.18)

- Status: accepted
- Date: 2026-10-22

## Context

Busy channels need side conversations that do not flood the timeline, a place for the
messages a channel keeps coming back to, a personal "later" list, and one view of what
happened to you across channels. Mattermost and Slack have all of these; they must work
with the live events, unread counts and notifications Cenacle already has.

## Decisions

1. **Threads are one level deep.** A reply stores `root_id` (the first message of the
   thread, in the same channel); replying to a reply attaches to its root. A reply stays in
   its thread unless its author also sends it to the channel (`also_in_channel`). The
   channel timeline, its unread and mention counts and its read position ignore replies kept
   in their thread.
2. **Thread summaries** (reply count, last reply, the latest three repliers) are computed
   when messages are read, not stored; `thread.updated` tells the channel's members when
   they change (a reply sent, deleted or restored). Deleting a thread's first message
   deletes its replies with it when it is purged.
3. **Following**: the root's author, every replier and the people mentioned follow a thread
   (`thread_follows`, with a read position). Choosing to stop following is kept: later
   replies do not make you follow again. Replies in followed threads notify as mentions
   (sound, desktop, web push, e-mail) and count under Threads, not in the channel.
4. **Pins**: people who can post pin up to 50 messages per channel (`pinned_at`,
   `pinned_by`); changes travel as `message.updated`. The channel details list them.
5. **Saved for later**: up to 500 saved messages per person, with "In progress" and "Done"
   and an optional reminder. A reminder is a scheduled message from the workspace's system
   bot (the `/remind` machinery) with a link to the saved message; changing it or marking
   the item done cancels the old one.
6. **Activity** (mentions, replies in followed threads, reactions to your messages, 30
   days) and **All unreads** (the 20 latest unread messages per channel) are queries over
   existing data, without new tables.
7. **Links to messages**: `/c/<channel>?m=<message>` opens the message in place, or its
   thread for a reply; reminders use them.

## Consequences

- Threads deeper than one level are not possible, which keeps the model simple.
- Summaries cost an aggregate query per page of messages; an index on `root_id` keeps it
  small. If load tests (v0.27) show it matters, they can be cached.
