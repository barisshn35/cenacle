// SPDX-License-Identifier: AGPL-3.0-only

// Package db owns the PostgreSQL connection pool of the chat database.
package db

import (
	"context"
	"fmt"

	"github.com/exaring/otelpgx"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/barisshn35/cenacle/server/internal/telemetry"
)

// Open creates a connection pool of up to maxConns connections (0: the
// default of pgx, one per CPU, at least 4). Connections are established
// lazily, so the server can start (and report "not ready") while the database
// is down.
func Open(ctx context.Context, url string, maxConns int32) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	if maxConns > 0 {
		cfg.MaxConns = maxConns
	}
	cfg.ConnConfig.RuntimeParams["application_name"] = "cenacle-server"
	// The server runs short indexed queries: compiling them (JIT) costs more
	// than it saves. Set as a connection parameter, it can be overridden in the URL.
	if _, set := cfg.ConnConfig.RuntimeParams["jit"]; !set {
		cfg.ConnConfig.RuntimeParams["jit"] = "off"
	}
	if telemetry.TracingEnabled() {
		cfg.ConnConfig.Tracer = otelpgx.NewTracer()
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}
	return pool, nil
}

// Checker is the readiness check for the database.
type Checker struct{ Pool *pgxpool.Pool }

func (Checker) Name() string { return "postgres" }

func (c Checker) Check(ctx context.Context) error { return c.Pool.Ping(ctx) }
