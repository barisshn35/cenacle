-- SPDX-License-Identifier: Apache-2.0
--
-- Direct and group messages, and read positions for unread counts.

-- +goose Up
ALTER TABLE channels DROP CONSTRAINT channels_kind_check;
ALTER TABLE channels ADD CONSTRAINT channels_kind_check
    CHECK (kind IN ('standard', 'announcement', 'direct', 'group'));
-- Direct and group conversations are private and never for everyone. Their
-- name is an internal key ("direct:<a>:<b>", "group:<hash>") that keeps one
-- conversation per set of people; clients show the participants instead.
ALTER TABLE channels ADD CONSTRAINT channels_conversation_private
    CHECK (kind NOT IN ('direct', 'group') OR (visibility = 'private' AND NOT is_default));

-- The last message a member has read; NULL: nothing read yet.
ALTER TABLE channel_members ADD COLUMN last_read_id uuid;

-- What was sent before someone joined is history, not unread: members start
-- reading at the channel's newest message (also for every member at upgrade).
UPDATE channel_members m
SET last_read_id = (SELECT x.id FROM messages x WHERE x.channel_id = m.channel_id ORDER BY x.id DESC LIMIT 1);

-- +goose StatementBegin
CREATE FUNCTION channel_members_start_reading() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.last_read_id IS NULL THEN
        NEW.last_read_id := (SELECT id FROM messages WHERE channel_id = NEW.channel_id ORDER BY id DESC LIMIT 1);
    END IF;
    RETURN NEW;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER channel_members_start_reading BEFORE INSERT ON channel_members
    FOR EACH ROW EXECUTE FUNCTION channel_members_start_reading();

-- +goose Down
DROP TRIGGER channel_members_start_reading ON channel_members;
DROP FUNCTION channel_members_start_reading();
ALTER TABLE channel_members DROP COLUMN last_read_id;
DELETE FROM channels WHERE kind IN ('direct', 'group');
ALTER TABLE channels DROP CONSTRAINT channels_conversation_private;
ALTER TABLE channels DROP CONSTRAINT channels_kind_check;
ALTER TABLE channels ADD CONSTRAINT channels_kind_check CHECK (kind IN ('standard', 'announcement'));
