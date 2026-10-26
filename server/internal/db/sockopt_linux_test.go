// SPDX-License-Identifier: AGPL-3.0-only

package db

import (
	"context"
	"net"
	"os"
	"syscall"
	"testing"
)

func TestConnectionsDetectDeadPeers(t *testing.T) {
	url := os.Getenv("CENACLE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("CENACLE_TEST_DATABASE_URL not set")
	}
	pool, err := Open(context.Background(), url, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	conn, err := pool.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	tcp, ok := conn.Conn().PgConn().Conn().(*net.TCPConn)
	if !ok {
		t.Skipf("not a TCP connection: %T", conn.Conn().PgConn().Conn())
	}
	raw, err := tcp.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var timeout, keepalive int
	_ = raw.Control(func(fd uintptr) {
		timeout, _ = syscall.GetsockoptInt(int(fd), syscall.IPPROTO_TCP, tcpUserTimeout)
		keepalive, _ = syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_KEEPALIVE)
	})
	if timeout != int(DeadPeerTimeout.Milliseconds()) || keepalive != 1 {
		t.Errorf("TCP_USER_TIMEOUT = %d ms, SO_KEEPALIVE = %d", timeout, keepalive)
	}
}
