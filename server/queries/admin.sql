-- name: InstanceCounts :one
-- InstanceCounts summarizes the installation (support bundle, status).
SELECT
    (SELECT count(*) FROM users WHERE NOT is_bot)                     AS people,
    (SELECT count(*) FROM users WHERE is_bot)                         AS bots,
    (SELECT count(*) FROM workspaces)                                 AS workspaces,
    (SELECT count(*) FROM channels)                                   AS channels,
    (SELECT count(*) FROM messages WHERE deleted_at IS NULL)          AS messages,
    (SELECT count(*) FROM files WHERE status = 'ready')               AS files,
    (SELECT coalesce(sum(size), 0)::bigint FROM files WHERE status = 'ready') AS file_bytes,
    (SELECT count(*) FROM sessions WHERE expires_at > now())          AS sessions,
    (SELECT count(*) FROM event_outbox)                               AS outbox_backlog,
    (SELECT count(*) FROM event_deliveries WHERE status = 'pending')  AS deliveries_pending,
    (SELECT count(*) FROM event_deliveries WHERE status = 'failed')   AS deliveries_failed,
    (SELECT count(*) FROM scheduled_messages WHERE status = 'pending') AS scheduled_pending;
