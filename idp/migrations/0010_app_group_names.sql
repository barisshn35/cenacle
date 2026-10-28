-- SPDX-License-Identifier: AGPL-3.0-only
-- Cenacle ID: apps see an identity provider's groups as "<provider>/<name>"
-- (ADR 0045). The people in them count as changed, so the chat's directory feed
-- brings their groups up to date without waiting for a sign-in.

-- Up Migration

UPDATE users SET updated_at = now() WHERE id IN (
  SELECT ug.user_id FROM user_groups ug
  JOIN directory_groups g ON g.id = ug.group_id
  JOIN identity_sources s ON s.id = g.source_id
  WHERE s.kind IN ('oidc', 'saml'));

-- Down Migration

-- The previous release names the groups again; the feed brings that over too.
UPDATE users SET updated_at = now() WHERE id IN (
  SELECT ug.user_id FROM user_groups ug
  JOIN directory_groups g ON g.id = ug.group_id
  JOIN identity_sources s ON s.id = g.source_id
  WHERE s.kind IN ('oidc', 'saml'));
