// SPDX-License-Identifier: AGPL-3.0-only

//go:build !linux

package db

import (
	"syscall"
	"time"
)

// userTimeout does nothing where TCP_USER_TIMEOUT does not exist; keepalives
// still end idle dead connections.
func userTimeout(time.Duration) func(network, address string, c syscall.RawConn) error {
	return nil
}
