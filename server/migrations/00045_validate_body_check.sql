-- +goose Up
-- Validates the message rule 00044 added NOT VALID. VALIDATE takes a lock that
-- lets reads and writes go on; on installations that ran 00044 before 0.41 the
-- rule is valid already and nothing is scanned.
ALTER TABLE messages VALIDATE CONSTRAINT messages_body_check;

-- +goose Down
SELECT 1;
