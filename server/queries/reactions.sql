-- name: AddReaction :execrows
INSERT INTO message_reactions (message_id, emoji, user_id) VALUES (@message_id, @emoji, @user_id)
ON CONFLICT DO NOTHING;

-- name: RemoveReaction :execrows
DELETE FROM message_reactions WHERE message_id = @message_id AND emoji = @emoji AND user_id = @user_id;

-- name: CountReactionKinds :one
SELECT count(DISTINCT emoji)::int FROM message_reactions WHERE message_id = @message_id;

-- name: ListReactions :many
-- ListReactions sums up the reactions of messages: count and whether the user
-- reacted, in the order the emoji were first used.
SELECT message_id, emoji, count(*)::int AS count, bool_or(user_id = @user_id) AS me
FROM message_reactions
WHERE message_id = ANY(@message_ids::uuid[])
GROUP BY message_id, emoji
ORDER BY message_id, min(created_at);

-- name: AddMentions :exec
-- AddMentions stores the mentions of a message: only members of its channel.
INSERT INTO message_mentions (message_id, user_id)
SELECT @message_id, m.user_id FROM channel_members m
WHERE m.channel_id = @channel_id AND m.user_id = ANY(@user_ids::uuid[])
ON CONFLICT DO NOTHING;

-- name: AddBroadcastMentions :exec
-- AddBroadcastMentions records a mention of many (@channel, @here, @admins)
-- for each member it reaches: everyone but the author, those online (users,
-- for @here) or those with a workspace role (role).
INSERT INTO message_mentions (message_id, user_id, kind)
SELECT @message_id, m.user_id, @kind
FROM channel_members m
JOIN channels c ON c.id = m.channel_id
JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = m.user_id
JOIN users u ON u.id = m.user_id AND NOT u.is_bot
WHERE m.channel_id = @channel_id AND m.user_id <> @author_id
  AND (sqlc.narg(users)::uuid[] IS NULL OR m.user_id = ANY(sqlc.narg(users)::uuid[]))
  AND (sqlc.narg(roles)::text[] IS NULL OR wm.role = ANY(sqlc.narg(roles)::text[]))
ON CONFLICT DO NOTHING;

-- name: DeleteMentions :exec
DELETE FROM message_mentions WHERE message_id = @message_id;

-- name: ListMentions :many
SELECT mm.message_id, u.id AS user_id, u.display_name
FROM message_mentions mm JOIN users u ON u.id = mm.user_id
WHERE mm.message_id = ANY(@message_ids::uuid[]) AND mm.kind = 'person'
ORDER BY mm.message_id, lower(u.display_name);
