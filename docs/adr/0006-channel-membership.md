# 0006. Channel membership, default channels and one administrator

- Status: accepted
- Date: 2026-10-21

## Context

The owner wants channels that everyone belongs to set up at installation, one of them —
Central — mandatory for everyone and closed for writing, and channel creation limited to
a single person until roles are designed (v0.6). Channel names are shown without "#".

## Decisions

1. **Membership.** `channel_members(channel_id, user_id)`. The sidebar lists the user's
   channels; the directory (`GET /api/channels/directory`) lists all with `is_member`.
   Reading, sending and live events require membership. Joining and leaving are
   self-service (`POST /api/channels/{id}/join|leave`).
2. **Channels from the installation.** `CENACLE_ANNOUNCEMENT_CHANNEL` (default `Central`)
   and `CENACLE_DEFAULT_CHANNELS` (default `General`) are applied at every start of every
   instance: created if missing, otherwise brought to the configured kind and flags (the
   topic is kept), and every user is made a member. Startup retries while the database is
   down. Configuration rather than a setup wizard: it works for unattended and air-gapped
   installations and is visible in `.env.prod`.
3. **Default and mandatory.** Default channels have every user as a member, also users who
   sign in for the first time later (joined at sign-in). Mandatory channels are default
   channels that cannot be left (`403 channel_mandatory`). The announcement channel is
   both.
4. **Announcement channels.** Everyone reads; only the administrator posts
   (`403 read_only_channel` for others). A channel nobody can post in would stay empty, so
   the administrator is the exception. Members see a note in place of the composer.
5. **One administrator until roles.** `users.is_admin`, at most one (partial unique index).
   It is the account whose **verified** e-mail address equals `CENACLE_ADMIN_EMAIL`, set
   at sign-in; at startup the flag is taken from an account whose address no longer
   matches. The administrator creates channels (`POST /api/channels`, optionally for
   everyone) and posts in announcement channels. The session exposes
   `permissions.create_channels`, so the web app does not depend on the flag itself and
   roles can replace it without changing clients.
6. **Display names.** Channel names are what people see ("Central", "Release notes"): up to
   80 characters, no control characters, trimmed, unique regardless of case
   (`lower(name)` index). URLs use ids (`/c/<id>`), so names can change later. The UI shows
   names without "#" and uses an icon per kind (megaphone for announcements).
7. **Events follow membership.** Each WebSocket connection loads its user's channels when it
   opens and updates them from `channel.joined`/`channel.left` (for that user) and
   `channel.created` (a default channel, for everyone). Messages of other channels are not
   sent; unknown event types stay on the server.
8. **Leaving is undoable, not confirmed.** Leaving a channel shows "Undo" (rejoin) instead
   of a confirmation dialog (UX plan: reversible actions get undo).

## Consequences

- Private channels (invitation only) and channel management (rename, archive, topic) come
  with roles in v0.6; the directory then hides channels a user may not see.
- The administrator is a single point of authority; losing access to that account means
  changing `CENACLE_ADMIN_EMAIL` and restarting.
