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

-- name: DeleteMentions :exec
DELETE FROM message_mentions WHERE message_id = @message_id;

-- name: ListMentions :many
SELECT mm.message_id, u.id AS user_id, u.display_name
FROM message_mentions mm JOIN users u ON u.id = mm.user_id
WHERE mm.message_id = ANY(@message_ids::uuid[])
ORDER BY mm.message_id, lower(u.display_name);
