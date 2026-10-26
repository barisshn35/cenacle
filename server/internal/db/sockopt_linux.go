// SPDX-License-Identifier: AGPL-3.0-only

package db

import (
	"syscall"
	"time"
)

// tcpUserTimeout is TCP_USER_TIMEOUT from linux/tcp.h.
const tcpUserTimeout = 0x12

// userTimeout sets TCP_USER_TIMEOUT on a connection's socket.
func userTimeout(d time.Duration) func(network, address string, c syscall.RawConn) error {
	return func(_, _ string, c syscall.RawConn) error {
		var err error
		if cerr := c.Control(func(fd uintptr) {
			err = syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP, tcpUserTimeout, int(d.Milliseconds()))
		}); cerr != nil {
			return cerr
		}
		return err
	}
}
