-- +goose Up
-- One completion at a time checks an upload: it claims the file (a fresh
-- claim id, held until check_until) before moving the upload to the file's
-- key, and only that claim may record the verdict. A completion that dies
-- leaves the claim to expire.
ALTER TABLE files ADD COLUMN check_claim uuid, ADD COLUMN check_until timestamptz;

-- +goose Down
ALTER TABLE files DROP COLUMN check_until, DROP COLUMN check_claim;
