// SPDX-License-Identifier: AGPL-3.0-only

// Package clamav scans streams with clamd (ClamAV's daemon) over TCP, using
// the INSTREAM command. ClamAV runs as its own service; nothing is linked.
package clamav

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

// chunk is the size of each INSTREAM chunk (clamd's StreamMaxLength still applies).
const chunk = 64 << 10

// Scanner talks to one clamd.
type Scanner struct {
	Addr    string
	Timeout time.Duration
}

// Result of a scan: Clean, or the name of what was found.
type Result struct {
	Clean bool
	Found string
}

// Scan sends r to clamd and returns its verdict.
func (s *Scanner) Scan(ctx context.Context, r io.Reader) (Result, error) {
	timeout := s.Timeout
	if timeout == 0 {
		timeout = 2 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", s.Addr)
	if err != nil {
		return Result{}, fmt.Errorf("clamav: %w", err)
	}
	defer func() { _ = conn.Close() }()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	if _, err := io.WriteString(conn, "zINSTREAM\x00"); err != nil {
		return Result{}, fmt.Errorf("clamav: %w", err)
	}
	buf := make([]byte, chunk)
	size := make([]byte, 4)
	for {
		n, rerr := r.Read(buf)
		if n > 0 {
			binary.BigEndian.PutUint32(size, uint32(n)) //nolint:gosec // n <= chunk
			if _, err := conn.Write(size); err != nil {
				return Result{}, fmt.Errorf("clamav: %w", err)
			}
			if _, err := conn.Write(buf[:n]); err != nil {
				return Result{}, fmt.Errorf("clamav: %w", err)
			}
		}
		if errors.Is(rerr, io.EOF) {
			break
		}
		if rerr != nil {
			return Result{}, rerr
		}
	}
	if _, err := conn.Write([]byte{0, 0, 0, 0}); err != nil {
		return Result{}, fmt.Errorf("clamav: %w", err)
	}
	reply, err := bufio.NewReader(conn).ReadString(0)
	if err != nil && !errors.Is(err, io.EOF) {
		return Result{}, fmt.Errorf("clamav: %w", err)
	}
	return parse(strings.TrimRight(reply, "\x00\n"))
}

// parse reads "stream: OK", "stream: <name> FOUND" or "... ERROR".
func parse(reply string) (Result, error) {
	_, verdict, _ := strings.Cut(reply, ": ")
	switch {
	case verdict == "OK":
		return Result{Clean: true}, nil
	case strings.HasSuffix(verdict, " FOUND"):
		return Result{Found: strings.TrimSuffix(verdict, " FOUND")}, nil
	default:
		return Result{}, fmt.Errorf("clamav: %q", reply)
	}
}
