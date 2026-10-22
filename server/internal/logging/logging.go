// SPDX-License-Identifier: AGPL-3.0-only

// Package logging builds the process-wide structured logger.
package logging

import (
	"io"
	"log/slog"

	"github.com/barisshn35/cenacle/server/internal/telemetry"
)

// New returns a slog.Logger writing to w in the given format ("json" or "text").
func New(w io.Writer, format string, level slog.Level) *slog.Logger {
	opts := &slog.HandlerOptions{Level: level}
	var h slog.Handler
	if format == "text" {
		h = slog.NewTextHandler(w, opts)
	} else {
		h = slog.NewJSONHandler(w, opts)
	}
	return slog.New(telemetry.LogHandler{Handler: h}).With("service", "cenacle-server")
}
