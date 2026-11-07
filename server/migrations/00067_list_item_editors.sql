-- +goose Up
-- Who last changed a row of a list (its title or values), shown with who added it.
ALTER TABLE list_items ADD COLUMN updated_by uuid REFERENCES users (id) ON DELETE SET NULL;

-- +goose Down
ALTER TABLE list_items DROP COLUMN updated_by;
