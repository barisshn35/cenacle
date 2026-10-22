# 0023. Community and moderation (v0.19)

- Status: accepted
- Date: 2026-10-22

## Context

Larger workspaces need places for longer discussions, quick decisions and planned
gatherings; their owners need tools to keep conversations civil and to repeat
processes reliably; operators need to tell everyone something and to make people accept
terms. Mattermost (Boards and Playbooks included) and Discord have these; Cenacle offers
them openly, without a paid tier.

## Decisions

1. **Forums are a channel kind.** A post is a thread's first message with a title and up
   to five of the channel's tags; answers live in its thread (ADR 0021). The channel view
   lists posts by latest activity instead of a timeline.
2. **Polls belong to a message** (its text is the question): 2–10 options, single or
   multiple choice, optionally anonymous (voters hidden from everyone, counts shown) and
   closing at a time or by its author or a channel manager. `poll.updated` carries the
   poll as the voter sees it; clients keep their own choices.
3. **Events** belong to a workspace and optionally a channel, where they are announced.
   "Going" schedules a reminder 15 minutes before (a system-bot message, as `/remind`);
   moving or canceling an event moves or cancels the reminders.
4. **Moderation tools**:
   - Slow mode per channel (managers and workspace admins exempt).
   - Timeouts per workspace member (no messages, reactions or votes; owners and admins
     cannot be timed out; up to 28 days).
   - AutoMod rules per workspace, checked before a message is stored: keywords (accent-
     and case-insensitive, `*` for prefixes), too many mentions, links to domains outside
     an allow list; a rule blocks the message or flags it (sent and reported). Owners and
     admins are exempt by default.
   - Reports from members (one open report per person and message) and AutoMod flags form
     the moderation queue; resolving dismisses, deletes the message or times its author out,
     for every open report of that message. Timeouts and resolutions are audited.
5. **Welcome**: a workspace message, rules and suggested public channels, shown once to each
   member; closing it joins the chosen channels.
6. **Playbooks** (Mattermost Playbooks): checklists a workspace's owners and admins write;
   a run copies them into a channel, where members check items off and the owner or a
   manager finishes it. The channel is told when a run starts and finishes.
7. **Banner and terms of service** are instance-wide and set by instance administrators.
   Terms are versioned; until a person accepts the version in force, the API answers
   `terms_required` to everything except their session, the terms themselves, sign-out
   and interface texts (cached for 10 seconds per server). Bots are not asked.

## Consequences

- AutoMod is word- and domain-based, not semantic; a stricter filter can run as a bot
  subscribing to message events.
- Run checklists are copied when a run starts: changing a playbook later does not change
  runs in progress.
- Terms changes reach every server within the cache's 10 seconds.
