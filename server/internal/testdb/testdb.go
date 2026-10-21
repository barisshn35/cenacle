// SPDX-License-Identifier: Apache-2.0

// Package testdb gives integration tests a migrated, empty chat database.
//
// Tests use CENACLE_TEST_DATABASE_URL (a separate database: they truncate
// tables). Without it they are skipped locally and fail in CI.
package testdb

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/barisshn35/cenacle/server/migrations"
)

// Open migrates the test database, empties its tables and returns a pool
// that is closed when the test ends.
func Open(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("CENACLE_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("CENACLE_TEST_DATABASE_URL is not set")
		}
		t.Skip("CENACLE_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	sqlDB := stdlib.OpenDBFromPool(pool)
	defer func() { _ = sqlDB.Close() }()
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Up(ctx); err != nil {
		t.Fatalf("migrate test database: %v", err)
	}
	if _, err := pool.Exec(ctx, "TRUNCATE users, sessions"); err != nil {
		t.Fatal(err)
	}
	return pool
}
