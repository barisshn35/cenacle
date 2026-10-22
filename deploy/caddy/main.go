// SPDX-License-Identifier: AGPL-3.0-only

// Command caddy builds the Caddy web server from source with Cenacle's Go
// toolchain, so security fixes in Go and golang.org/x/net ship without waiting
// for an upstream Caddy release. Only the standard modules are included.
package main

import (
	caddycmd "github.com/caddyserver/caddy/v2/cmd"

	_ "github.com/caddyserver/caddy/v2/modules/standard"
)

func main() {
	caddycmd.Main()
}
