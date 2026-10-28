# 0046. Group mappings follow renamed groups (v0.99.3)

- Status: accepted
- Date: 2026-10-28

## Context

Since 0.99.2 ([ADR 0045](0045-group-names-by-source.md)) Cenacle ID names an identity
provider's groups `<provider>/<group>` for apps, and renaming a provider renames its groups.
The chat matches its workspace and channel group mappings to these names literally
(case-insensitively), so every mapping of a provider's group by its old name stopped
matching: the memberships and roles it gave were taken back at the next sign-in or feed
change, until an administrator mapped the group again by hand. The 0.99.2 upgrade notes asked
for exactly that, and a provider rename asked for it again.

Following a rename must not reopen the collision ADR 0045 closed: a mapping meant for a
directory's group, or for another provider's, must never pass to a provider's group.

## Decisions

1. **Cenacle ID records every change of an app-facing group name** in
   `group_name_changes` (old name, new name, `ambiguous`). Migration `0011` records the 0.99.2
   rule for the groups that existed then: a provider's group from its bare name to its
   prefixed one, except when a directory group has the bare name (the bare mapping keeps
   meaning the directory's group, so nothing is recorded); a bare name several providers had
   is recorded once per provider as ambiguous. Renaming a provider records the old and new
   prefixed name of each of its groups, ambiguous when a directory group has the old name.
   The naming rule lives in one place (`appGroupName` in `idp/src/directory/store.ts`);
   migration `0011` is a snapshot of it. Names longer than 200 characters, which apps never
   see, are left out.
2. **Two providers never share a prefix.** The prefix is the provider's name with `/` as `-`,
   so the administration's uniqueness check and a new unique index compare that form,
   case-insensitively. Migration `0012` renames every provider but the oldest of a set that
   shares one to `<name> (<id>)` and records its groups' new names as ambiguous.
3. **The chat reads the changes through the directory feed's authentication**
   (`GET /directory/v1/group-renames?after=<id>`, the same Basic credentials and
   `directory_feed` registration, oldest first, 500 a page, the last two seconds held back
   like the feed). Its directory sync applies them, from a cursor kept in the database,
   **before** the changed people:
   - an unambiguous change moves the mappings of the old name to the new one with their role;
     where the workspace or channel maps the new name already, that mapping stays as it is
     (its role is not raised) and the old one is removed; the groups people are in follow too;
   - an ambiguous change moves nothing: the mapping is marked for review with the new names
     as candidates and matches none of them;
   - a rename never creates a mapping, and every moved, removed or marked mapping is in the
     workspace's audit log (`workspace.group_mapping_renamed`/`_merged`/`_needs_review`,
     `channel.group_renamed`/`_merged`/`_needs_review`, no actor, `by: cenacle_id`).
4. **Administrators review marked mappings** in the workspace and channel group settings:
   use one of the candidate names (a normal mapping change), keep the mapping as it is (saving
   a workspace mapping, or naming the group in `reviewed` for a channel), or remove it.
5. **A sign-in with a provider's groups follows pending changes first** (at most two seconds;
   a failure is logged and the sign-in goes on), so a person signing in before the next sync
   does not lose and regain memberships.

## Consequences

- Upgrades from 0.99.1 and 0.99.2 keep the mappings of provider groups working without manual
  steps, except where the name was ambiguous; those wait for an administrator, as before but
  now listed.
- Without the directory feed (`directory_feed` off for the chat's client) renames are not
  followed: mappings of renamed groups match nothing until they are mapped again, and nothing
  is marked for review. The shipped Compose and Helm configurations turn the feed on. No
  fallback suggests names from the groups people are in: matching a mapping's bare name to
  `<any provider>/<name>` is the guess ADR 0045 forbids, and the feed gives the exact answer.
- Cenacle ID keeps the recorded changes; they are a few rows a group per rename.
