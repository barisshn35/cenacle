// SPDX-License-Identifier: AGPL-3.0-only

// Package testdb gives integration tests their own migrated database schema
// and a Valkey connection.
//
// Tests use CENACLE_TEST_DATABASE_URL and CENACLE_TEST_VALKEY_ADDR. Without
// them they are skipped locally and fail in CI. Every test gets a fresh
// schema (dropped afterwards), so packages and tests can run in parallel.
package testdb

import (
	"cmp"
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/barisshn35/cenacle/server/internal/cache"
	"github.com/barisshn35/cenacle/server/internal/storage"
	"github.com/barisshn35/cenacle/server/migrations"
)

func env(t *testing.T, name string) string {
	t.Helper()
	v := os.Getenv(name)
	if v == "" {
		if os.Getenv("CI") != "" {
			t.Fatalf("%s is not set", name)
		}
		t.Skipf("%s is not set", name)
	}
	return v
}

// Suffix returns a random string for names private to one test.
func Suffix() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Open creates a schema, migrates it and returns a pool whose connections use
// it. Pool and schema are removed when the test ends.
func Open(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := env(t, "CENACLE_TEST_DATABASE_URL")
	ctx := context.Background()
	schema := "test_" + Suffix()

	admin, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	// Extensions belong to the database, not to a schema: test packages that
	// migrate at the same time on a fresh database would race to create them
	// ("IF NOT EXISTS" does not guard against that), so one creates them first.
	if _, err := admin.Exec(ctx, "BEGIN; SELECT pg_advisory_xact_lock(7419001); "+
		"CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA public; COMMIT"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		_ = admin.Close(context.Background())
	})

	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	if n, err := strconv.Atoi(os.Getenv("CENACLE_TEST_DB_MAX_CONNS")); err == nil && n > 0 {
		cfg.MaxConns = int32(n) //nolint:gosec // a test setting
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close) // runs before the schema is dropped

	sqlDB := stdlib.OpenDBFromPool(pool)
	defer func() { _ = sqlDB.Close() }()
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Up(ctx); err != nil {
		t.Fatalf("migrate test schema: %v", err)
	}
	return pool
}

// Valkey returns a client of the test Valkey, closed when the test ends.
// Tests use keys of their own (see Suffix).
func Valkey(t *testing.T) *cache.Client {
	t.Helper()
	c := cache.New(env(t, "CENACLE_TEST_VALKEY_ADDR"), os.Getenv("CENACLE_TEST_VALKEY_PASSWORD"))
	t.Cleanup(c.Close)
	if err := c.Check(context.Background()); err != nil {
		t.Fatalf("test valkey: %v", err)
	}
	return c
}

// Storage returns the test object store (a bucket shared by tests; keys are
// unique per file).
func Storage(t *testing.T) *storage.S3 {
	t.Helper()
	s, err := storage.New(storage.Config{
		Endpoint:  env(t, "CENACLE_TEST_S3_ENDPOINT"),
		Region:    cmp.Or(os.Getenv("CENACLE_TEST_S3_REGION"), "garage"),
		Bucket:    cmp.Or(os.Getenv("CENACLE_TEST_S3_BUCKET"), "cenacle-files"),
		AccessKey: env(t, "CENACLE_TEST_S3_ACCESS_KEY"),
		SecretKey: env(t, "CENACLE_TEST_S3_SECRET_KEY"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Check(context.Background()); err != nil {
		t.Fatalf("test object store: %v", err)
	}
	return s
}
