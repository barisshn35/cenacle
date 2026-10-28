-- SPDX-License-Identifier: AGPL-3.0-only
-- Cenacle ID: changes of the names apps see for groups (ADR 0046), so the
-- chat's group mappings follow them. The directory feed's clients read them at
-- /directory/v1/group-renames.

-- Up Migration

CREATE TABLE group_name_changes (
  id         bigserial   PRIMARY KEY,
  old_name   text        NOT NULL,
  new_name   text        NOT NULL,
  -- Several groups took the name before: an app may not pick one by itself.
  ambiguous  boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 0.99.2 (ADR 0045) named an identity provider's groups "<provider>/<name>"
-- for apps. This is that rule as it stood then (src/directory/store.ts
-- appGroupName); a later change of the rule records its own changes. A bare
-- name that is also a directory's group keeps meaning the directory's group;
-- one that several providers have is ambiguous. Names longer than 200
-- characters never reached apps.
WITH c AS (
  SELECT g.name AS old_name, replace(s.name, '/', '-') || '/' || g.name AS new_name, s.id AS source_id
  FROM directory_groups g JOIN identity_sources s ON s.id = g.source_id
  WHERE s.kind <> 'ldap'
    AND char_length(replace(s.name, '/', '-') || '/' || g.name) <= 200
    AND NOT EXISTS (
      SELECT 1 FROM directory_groups dg JOIN identity_sources ds ON ds.id = dg.source_id
      WHERE ds.kind = 'ldap' AND lower(dg.name) = lower(g.name))
), n AS (
  SELECT lower(old_name) AS k, count(DISTINCT source_id) AS providers FROM c GROUP BY 1
)
INSERT INTO group_name_changes (old_name, new_name, ambiguous)
SELECT old_name, new_name, ambiguous FROM (
  SELECT DISTINCT c.old_name, c.new_name, n.providers > 1 AS ambiguous
  FROM c JOIN n ON n.k = lower(c.old_name)) d
ORDER BY lower(old_name), old_name, new_name;

-- Their people count as changed: the feed sends them again after the changes.
UPDATE users SET updated_at = now() WHERE id IN (
  SELECT ug.user_id FROM user_groups ug
  JOIN directory_groups g ON g.id = ug.group_id
  JOIN identity_sources s ON s.id = g.source_id
  WHERE s.kind <> 'ldap');

-- Down Migration

DROP TABLE group_name_changes;
