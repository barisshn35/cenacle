# 0037. System console, permission schemes and notification content (v0.34)

- Status: accepted
- Date: 2026-10-24

## Context

Items A-1, A-3 and A-7 of the 2026-10-23 plan. Installation administrators had the
settings dialog's few instance pages and the support bundle; workspaces had fixed rules
(owners and admins create channels, invite and organize; everyone mentions everyone);
notifications outside the app always carried the message text.

## Decisions

1. **The system console** is a dialog of the web app for installation administrators
   (`users.is_admin`), not a separate application: an overview (version, counts, people
   active in the last 30 days, the effective configuration with secrets shown only as
   "set", background jobs by state and the latest failures), the people of the
   installation (50 at a time with a keyset cursor, search, signing someone out
   everywhere), workspaces, bots (turning one off) and the notification policy. Its
   endpoints are under `/api/admin/` and every change is in the audit log. Accounts
   themselves stay in Cenacle ID, which already has its own administration.
2. **Permission schemes are per workspace**, stored as JSON over defaults that are exactly
   the 0.33 behaviour, so nothing changes on upgrade. Six permissions, each a set of roles
   (admin, member, guest): create channels, invite people, organize categories, add custom
   emoji, mention everyone, mention groups. Owners may always do everything. Bots stay with
   owners and admins (they hold secrets and post as themselves); group creation keeps the
   setting it had since 0.31. Clients receive the scheme and their own `can` list with the
   workspace.
3. **Channel moderation** is per channel: posting, answering in threads, reacting and
   mentioning everyone can each be left to the channel's managers and the workspace's
   admins. The rules are checked where the action is (the same pure checks as `can_post`)
   and returned to each member as `can_reply`, `can_react` and `can_broadcast`.
4. **Mentioning everyone without the right is refused** (`broadcast_not_allowed`) rather
   than silently not notifying, so the author knows. A group mention without the right is
   posted but notifies no one, because `@handle` may also be a person.
5. **Notification content policy** is instance-wide: web push and desktop notifications
   show the full text, only the sender and channel, or only that something arrived;
   e-mails the full text or only the sender and channel. The server applies it to what it
   sends; the web and desktop apps read it from `/api/meta`.

## Consequences

- Two migrations (`00034`, `00035`), reversible; rolling back forgets the schemes,
  channel moderation and the policy.
- A member who loses a permission keeps what they made (channels, invites, emoji).
