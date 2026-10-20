// SPDX-License-Identifier: Apache-2.0

// Package migrations embeds the SQL migrations of the chat database so they
// ship inside the server binary and always match its version.
package migrations

import "embed"

// FS holds the goose SQL migrations.
//
//go:embed *.sql
var FS embed.FS
