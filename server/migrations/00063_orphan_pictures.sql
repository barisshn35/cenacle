-- +goose Up
-- Pictures nothing shows any more: before this, erasing a person left their
-- profile picture behind. Those of the last hour stay, in case one is being
-- set right now. Apart from 00062, so that the short locks of its indexes are
-- not held while this runs (each deleted picture checks five foreign keys).
DELETE FROM pictures p
WHERE p.created_at < now() - interval '1 hour'
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.icon_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM link_previews l WHERE l.image_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM custom_emoji e WHERE e.picture_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM stickers s WHERE s.picture_id = p.id);

-- +goose Down
-- The pictures are gone; nothing to undo.
