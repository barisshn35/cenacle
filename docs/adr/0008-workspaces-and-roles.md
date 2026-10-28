# 0008. Workspaces, roles and invitations (v0.6)

- Status: accepted
- Date: 2026-10-21

## Context

Until v0.5 one installation was one community with a single administrator
(`CENACLE_ADMIN_EMAIL`). v0.6 brings the kickoff's model: workspaces holding
categories and channels, with roles kept in the chat server (the IdP only says who
someone is).

## Decisions

1. **Workspaces.** Channels and categories belong to a workspace; names are unique within
   it. The migration creates a default workspace ("Cenacle", renameable) and moves every
   existing channel, category and user into it. Every user who signs in joins the default
   workspace, so a fresh installation behaves as before.
2. **Roles per workspace: owner, admin, member.** Owners and admins create channels,
   organize categories, manage every channel (they count as channel managers) and post in
   announcement channels. Admins change members to admins and back; only owners grant or
   take the owner role and remove owners. A workspace always keeps one owner
   (`403 last_owner`); if its last owner becomes a directory guest, its admins name the
   next one. Channel managers stay as before and can now appoint other managers.
3. **The instance administrator.** `CENACLE_ADMIN_EMAIL` now names the instance
   administrator: they create workspaces and own the default workspace (made owner at
   sign-in). Changing the address does not take workspace roles away; owners do that.
4. **Invitations.** Owners and admins create links with a validity (1 to 30 days, 7 by
   default) and an optional use limit; the token is random (192 bits), stored as SHA-256 and
   shown once. Accepting counts a use with a conditional update, so limits hold under
   concurrent accepts; accepting again as a member changes nothing. Revoked, expired and
   used-up links answer `410`. Joining a workspace joins its channels for everyone.
5. **Isolation.** Outsiders see nothing of a workspace: its channels, directory, categories,
   members and messages answer `404`. People search (`GET /api/users`) is limited to one
   workspace, and only its members can be added to its channels.
6. **Leaving and removal.** Removing someone (or leaving) takes them out of every channel of
   the workspace. Nobody leaves the default workspace: everyone belongs there.
7. **Live events follow workspace membership.** Connections know their user's workspaces;
   `categories.changed`, `workspace.updated` and `workspace.members_changed` reach a
   workspace's members, `workspace.joined`/`left` the user concerned. On
   `workspace.joined` a connection reloads its memberships from the database, since joining
   a workspace joins several channels at once.
8. **Web.** The rail lists the user's workspaces; `/w/<id>` opens one, the app returns to the
   last one used. The workspace menu holds invitations, members and roles; `/invite/<token>`
   previews and joins. A workspace without channels still shows the shell.
9. **Sign-in rate limit.** Cenacle ID's 10 attempts per address and minute become
   configurable (`IDP_LOGIN_RATE_LIMIT`): offices behind one NAT share an address.

## Consequences

- API calls that list or create within a workspace take `workspace_id` (directory,
  categories, people search, new channels and categories).
- The session no longer reports `create_channels`; it reports `create_workspaces`, and rights
  inside a workspace come with each workspace (`role`) and channel (`can_post`,
  `can_manage`).
