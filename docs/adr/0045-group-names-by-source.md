# 0045. Group names carry their identity provider (v0.99.2)

- Status: accepted
- Date: 2026-10-28

## Context

Cenacle ID keeps groups per identity source (`directory_groups` is unique per source), but
sent them to apps by bare name in the `groups` claim and the directory feed. The chat maps
groups to workspace and channel memberships (and roles) by that name, case-insensitively.
A source run by someone less trusted than the directory, such as a partner's identity
provider or its SCIM client, could create a group with the name of a directory group (say
`Engineering Leads`) and give its people the role a workspace grants that group.

## Decisions

1. **Apps see an identity provider's groups as `<provider>/<group>`**, the provider's name
   in Cenacle ID with `/` replaced by `-`. A directory's (LDAP) groups keep their bare
   names, so existing directory mappings keep working. The first `/` separates the
   provider, so no provider can name a group like another provider's.
2. **Provider names are unique** (case-insensitively) in the administration: two providers
   never share the prefix. Renaming a provider renames its groups; its people count as
   changed, so the chat's directory feed follows within a minute.
3. **The chat does not change**: it matches mappings to the names it is given. Mappings of
   a provider's groups name them with the prefix; the groups list in the workspace and
   channel settings shows the names as they arrive.
4. **Names longer than 200 characters are left out** of the claim and the feed (the chat
   keeps at most 200), rather than cut to a name another group might have.
5. Inside Cenacle ID nothing changes: a provider's administrator and guest groups are still
   its own group names, without the prefix.

## Consequences

- After the upgrade, mappings of a provider's groups by their bare name stop matching and
  the memberships they gave are taken back at the next sign-in or feed change; they must
  be mapped again as `<provider>/<group>` (upgrade notes, 0.99.2). Since 0.99.3 the chat's
  mappings follow these renames by themselves ([ADR 0046](0046-group-mappings-follow-renames.md)).
- A directory group whose name starts with a provider's name and `/` could still meet that
  provider's group; directory names are set by the directory's administrators, whom
  Cenacle ID trusts as much as its own.
