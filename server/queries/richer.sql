-- name: ListPendingLinks :many
SELECT id, channel_id, link_url FROM messages
WHERE link_state = 'pending' AND deleted_at IS NULL
ORDER BY id LIMIT @row_limit;

-- name: SetLinkState :exec
UPDATE messages SET link_state = @link_state WHERE id = @id;

-- name: GetLinkPreview :one
SELECT * FROM link_previews WHERE url = @url;

-- name: UpsertLinkPreview :one
INSERT INTO link_previews (url, ok, title, description, site_name, image_id)
VALUES (@url, @ok, @title, @description, @site_name, sqlc.narg(image_id))
ON CONFLICT (url) DO UPDATE SET ok = EXCLUDED.ok, title = EXCLUDED.title, description = EXCLUDED.description,
    site_name = EXCLUDED.site_name, image_id = EXCLUDED.image_id, fetched_at = now()
RETURNING *;

-- name: PruneLinkPreviews :many
-- PruneLinkPreviews deletes up to row_limit link previews fetched before the
-- cut-off (CENACLE_LINK_PREVIEW_RETENTION) and returns their pictures; messages
-- that showed one show the bare link. A message posted later fetches it again.
DELETE FROM link_previews WHERE url IN (
    SELECT l.url FROM link_previews l WHERE l.fetched_at < @before::timestamptz LIMIT @row_limit
)
RETURNING image_id;

-- name: ListLinkPreviews :many
-- ListLinkPreviews returns the previews to show on messages.
SELECT m.id AS message_id, lp.url, lp.title, lp.description, lp.site_name, lp.image_id
FROM messages m
JOIN link_previews lp ON lp.url = m.link_url AND lp.ok
WHERE m.id = ANY(@message_ids::uuid[]) AND m.link_state = 'done';

-- name: ListCustomEmoji :many
SELECT * FROM custom_emoji WHERE workspace_id = @workspace_id ORDER BY name;

-- name: CountCustomEmoji :one
SELECT count(*)::int FROM custom_emoji WHERE workspace_id = @workspace_id;

-- name: CreateCustomEmoji :one
INSERT INTO custom_emoji (workspace_id, name, picture_id, created_by)
VALUES (@workspace_id, @name, @picture_id, @created_by)
RETURNING *;

-- name: GetCustomEmoji :one
SELECT * FROM custom_emoji WHERE id = @id;

-- name: CustomEmojiExists :one
SELECT EXISTS (SELECT 1 FROM custom_emoji WHERE workspace_id = @workspace_id AND name = @name);

-- name: DeleteCustomEmoji :exec
DELETE FROM custom_emoji WHERE id = @id;

-- name: ListStickers :many
SELECT * FROM stickers WHERE workspace_id = @workspace_id AND removed_at IS NULL ORDER BY created_at;

-- name: CountStickers :one
SELECT count(*)::int FROM stickers WHERE workspace_id = @workspace_id AND removed_at IS NULL;

-- name: CreateSticker :one
INSERT INTO stickers (workspace_id, name, picture_id, created_by, pack_id)
VALUES (@workspace_id, @name, @picture_id, @created_by, sqlc.narg(pack_id))
RETURNING *;

-- name: GetSticker :one
SELECT * FROM stickers WHERE id = @id;

-- name: ListStickersByID :many
SELECT * FROM stickers WHERE id = ANY(@ids::uuid[]);

-- name: HideUsedSticker :execrows
-- HideUsedSticker takes a sticker some message shows out of the picker; the
-- message keeps it.
UPDATE stickers s SET removed_at = now()
WHERE s.id = @id AND EXISTS (SELECT 1 FROM messages m WHERE m.sticker_id = s.id);

-- name: DeleteSticker :exec
DELETE FROM stickers WHERE id = @id;

-- name: ListPackStickers :many
SELECT * FROM stickers WHERE pack_id = @pack_id AND removed_at IS NULL;

-- name: ListStickerPacks :many
SELECT * FROM sticker_packs WHERE workspace_id = @workspace_id ORDER BY created_at;

-- name: CountStickerPacks :one
SELECT count(*)::int FROM sticker_packs WHERE workspace_id = @workspace_id;

-- name: CreateStickerPack :one
INSERT INTO sticker_packs (workspace_id, name, created_by)
VALUES (@workspace_id, @name, @created_by)
RETURNING *;

-- name: GetStickerPack :one
SELECT * FROM sticker_packs WHERE id = @id;

-- name: DeleteStickerPack :exec
DELETE FROM sticker_packs WHERE id = @id;

-- name: RevealBurn :one
-- RevealBurn records when a reader first saw a burn-on-read message.
INSERT INTO burn_reveals (message_id, user_id) VALUES (@message_id, @user_id)
ON CONFLICT (message_id, user_id) DO UPDATE SET revealed_at = burn_reveals.revealed_at
RETURNING revealed_at;

-- name: ListBurnReveals :many
SELECT message_id, revealed_at FROM burn_reveals
WHERE user_id = @user_id AND message_id = ANY(@message_ids::uuid[]);

-- name: PurgeBurned :one
-- PurgeBurned removes burn-on-read messages every other member has read and
-- whose time is up, and any older than a week. Messages a legal hold keeps are
-- deleted for people instead (and stay for eDiscovery).
WITH due AS (
    SELECT m.id, message_held(m.channel_id, m.author_id, m.created_at) OR thread_held(m.id) AS held
    FROM messages m
    WHERE m.burn_seconds IS NOT NULL AND m.deleted_at IS NULL
      AND (m.created_at < now() - interval '7 days'
           OR (NOT EXISTS (
                   SELECT 1 FROM channel_members cm
                   WHERE cm.channel_id = m.channel_id AND cm.user_id <> m.author_id
                     AND NOT EXISTS (SELECT 1 FROM burn_reveals b
                                     WHERE b.message_id = m.id AND b.user_id = cm.user_id
                                       AND b.revealed_at + make_interval(secs => m.burn_seconds) < now()))))
), gone AS (
    DELETE FROM messages WHERE id IN (SELECT id FROM due WHERE NOT held) RETURNING 1
), kept AS (
    UPDATE messages SET deleted_at = now() WHERE id IN (SELECT id FROM due WHERE held) RETURNING 1
)
SELECT ((SELECT count(*) FROM gone) + (SELECT count(*) FROM kept))::bigint;

-- name: ListMemberIDs :many
SELECT user_id FROM channel_members WHERE channel_id = @channel_id;

-- name: ListSavedStickerIDs :many
-- ListSavedStickerIDs returns which stickers of a workspace a person saved, newest first.
SELECT v.sticker_id FROM sticker_saves v JOIN stickers s ON s.id = v.sticker_id
WHERE v.user_id = @user_id AND s.workspace_id = @workspace_id AND s.removed_at IS NULL
ORDER BY v.created_at DESC;

-- name: SaveSticker :exec
INSERT INTO sticker_saves (user_id, sticker_id) VALUES (@user_id, @sticker_id)
ON CONFLICT DO NOTHING;

-- name: UnsaveSticker :exec
DELETE FROM sticker_saves WHERE user_id = @user_id AND sticker_id = @sticker_id;

-- name: DeleteStickerSaves :exec
-- DeleteStickerSaves forgets a sticker taken out of the picker in everyone's saved ones.
DELETE FROM sticker_saves WHERE sticker_id = @sticker_id;

-- name: ListUserGIFs :many
SELECT id, name, width, height, octet_length(data)::int AS size, created_at FROM user_gifs
WHERE user_id = @user_id ORDER BY created_at DESC;

-- name: CountUserGIFs :one
SELECT count(*)::int FROM user_gifs WHERE user_id = @user_id;

-- name: InsertUserGIF :one
INSERT INTO user_gifs (user_id, name, width, height, data) VALUES (@user_id, @name, @width, @height, @data)
RETURNING id, name, width, height, octet_length(data)::int AS size, created_at;

-- name: GetUserGIF :one
SELECT user_id, data FROM user_gifs WHERE id = @id;

-- name: DeleteUserGIF :execrows
DELETE FROM user_gifs WHERE id = @id AND user_id = @user_id;
