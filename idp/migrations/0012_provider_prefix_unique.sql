-- SPDX-License-Identifier: AGPL-3.0-only
-- Cenacle ID: two identity providers never give their groups the same prefix
-- for apps. The prefix is the provider's name with "/" as "-" (appGroupName),
-- so "Corp/EU" and "Corp-EU" shared one although their names differ, and
-- providers saved before 0.99.2 may share a name. Every provider but the
-- oldest of such a set is renamed "<name> (<id>)"; the new names of its
-- groups are recorded as ambiguous (the old ones met the other provider's), so
-- the chat asks its administrators about the mappings that used them.

-- Up Migration

CREATE TEMPORARY TABLE provider_renames ON COMMIT DROP AS
SELECT id, name AS old_name, name || ' (' || left(id::text, 8) || ')' AS new_name
FROM (
  SELECT id, name, row_number() OVER (
           PARTITION BY lower(replace(name, '/', '-')) ORDER BY created_at, id) AS r
  FROM identity_sources WHERE kind IN ('oidc', 'saml')) s
WHERE r > 1;

INSERT INTO group_name_changes (old_name, new_name, ambiguous)
SELECT o, n, true FROM (
  SELECT replace(p.old_name, '/', '-') || '/' || g.name AS o,
         replace(p.new_name, '/', '-') || '/' || g.name AS n
  FROM provider_renames p JOIN directory_groups g ON g.source_id = p.id) c
WHERE char_length(o) <= 200 AND char_length(n) <= 200
ORDER BY lower(o), o;

UPDATE users SET updated_at = now() WHERE id IN (
  SELECT ug.user_id FROM user_groups ug JOIN directory_groups g ON g.id = ug.group_id
  JOIN provider_renames p ON p.id = g.source_id);

UPDATE identity_sources s SET name = p.new_name, updated_at = now()
FROM provider_renames p WHERE s.id = p.id;

CREATE UNIQUE INDEX identity_sources_group_prefix
  ON identity_sources (lower(replace(name, '/', '-'))) WHERE kind IN ('oidc', 'saml');

-- Down Migration

-- Renamed providers keep their new names.
DROP INDEX identity_sources_group_prefix;
