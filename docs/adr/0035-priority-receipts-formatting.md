# 0035. Message priority, read receipts, galleries and formatting (v0.32)

- Status: accepted
- Date: 2026-10-24

## Context

Items M4, M5 and M13 of the 2026-10-23 plan: marking messages important or urgent and
asking for acknowledgements (with reminders for urgent ones), read receipts in
conversations — off by default, an administrator's decision — and a nicer look for
several images and for writing formatted messages.

## Decisions

1. **Priority belongs to messages in a channel's timeline** (`messages.priority`,
   `ack_requested`, `persistent`); replies have none, as in Mattermost. Acknowledgements
   (`message_acks`) are visible to everyone in the channel (`message.ack`).
2. **Reminders** go to the people an urgent message mentions — themselves or through a
   group — who are still in the channel and have not acknowledged it. A job looks every
   30 seconds and sends `message.reminder` as often and as many times as the workspace
   allows (`persistent_every_minutes`, `persistent_times`, or off), counting per person
   in `message_reminders`. Reminders ignore muting: the sender asked for attention. The
   apps play a sound, show a note and a desktop notification.
3. **Read receipts are off** until a workspace's owners or admins turn them on, and then
   only in direct and group conversations, where they matter and stay small. Everyone can
   keep theirs to themselves (`users.share_read_receipts`) and then sees no one else's —
   the reciprocity other chats use, and what works councils expect. Read positions
   already existed (`channel_members.last_read_id`); with receipts on, moving one sends
   `conversation.read` to the conversation's members.
4. **A formatting bar, not a rich-text editor.** Messages stay Markdown (the server keeps
   Markdown, ADR 0011): the bar writes Markdown for the selection and the preview renders
   it with the same renderer as messages. A WYSIWYG editor would need a second document
   model and its conversions to Markdown (mentions, groups, emoji); the bar gives the same
   help without them. The choice to show it is kept per device.
5. **Galleries** lay out two to four images in a grid (the rest counted on the last
   image); a single image keeps its own shape.

## Consequences

- Two migrations (`00030`, `00031`), reversible.
- Reminders reach the web and desktop apps live; offline people get them from the
  apps' notifications once they are back, as other mentions (web push stays per new
  message).
