-- +goose Up
-- Guests stay guests on every way into a workspace (policy.IsGuest): guests
-- of the directory, people who came by a guest link and people of federated
-- servers. Earlier versions made link guests and federated people members of
-- the default workspace at every start, let directory guests accept an
-- invitation as members and kept owners who became directory guests owners.
-- This repairs the rows those paths left.

-- Link guests and federated people are in the default workspace only as the
-- guests of a channel there; drop the memberships the start-up sweep gave.
DELETE FROM channel_members cm
USING channels c, workspaces w, workspace_members wm, users u
WHERE c.id = cm.channel_id AND w.id = c.workspace_id AND w.is_default
  AND wm.workspace_id = w.id AND wm.user_id = cm.user_id AND wm.role <> 'guest'
  AND u.id = cm.user_id AND (u.guest_link_id IS NOT NULL OR u.auth_service = 'remote');
DELETE FROM workspace_members wm
USING workspaces w, users u
WHERE w.id = wm.workspace_id AND w.is_default AND wm.role <> 'guest'
  AND u.id = wm.user_id AND (u.guest_link_id IS NOT NULL OR u.auth_service = 'remote');

-- Every guest is a guest wherever they are a member.
UPDATE workspace_members wm SET role = 'guest'
FROM users u
WHERE u.id = wm.user_id AND wm.role <> 'guest'
  AND (u.directory_role = 'guest' OR u.guest_link_id IS NOT NULL OR u.auth_service = 'remote');

-- Directory guests are never in channels for everyone (link guests may have
-- come by a link to one).
DELETE FROM channel_members cm
USING channels c, users u
WHERE c.id = cm.channel_id AND c.is_default AND u.id = cm.user_id
  AND u.directory_role = 'guest' AND u.guest_link_id IS NULL AND u.auth_service <> 'remote';

-- +goose Down
-- The repaired rows were wrong; they are not brought back.
SELECT 1;
