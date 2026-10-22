// SPDX-License-Identifier: AGPL-3.0-only

package clamav

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"net"
	"strings"
	"testing"
)

// fakeClamd answers like clamd: FOUND when the stream contains "EICAR".
func fakeClamd(t *testing.T) string {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = conn.Close() }()
				r := bufio.NewReader(conn)
				cmd, _ := r.ReadString(0)
				if cmd != "zINSTREAM\x00" {
					_, _ = io.WriteString(conn, "UNKNOWN COMMAND\x00")
					return
				}
				var data bytes.Buffer
				size := make([]byte, 4)
				for {
					if _, err := io.ReadFull(r, size); err != nil {
						return
					}
					n := binary.BigEndian.Uint32(size)
					if n == 0 {
						break
					}
					if _, err := io.CopyN(&data, r, int64(n)); err != nil {
						return
					}
				}
				if strings.Contains(data.String(), "EICAR") {
					_, _ = io.WriteString(conn, "stream: Eicar-Test-Signature FOUND\x00")
					return
				}
				_, _ = io.WriteString(conn, "stream: OK\x00")
			}()
		}
	}()
	return l.Addr().String()
}

func TestScan(t *testing.T) {
	s := &Scanner{Addr: fakeClamd(t)}
	clean, err := s.Scan(context.Background(), strings.NewReader(strings.Repeat("a", 200_000)))
	if err != nil || !clean.Clean {
		t.Errorf("clean = %+v, %v", clean, err)
	}
	bad, err := s.Scan(context.Background(), strings.NewReader("x EICAR x"))
	if err != nil || bad.Clean || bad.Found != "Eicar-Test-Signature" {
		t.Errorf("infected = %+v, %v", bad, err)
	}
	if _, err := (&Scanner{Addr: "127.0.0.1:1"}).Scan(context.Background(), strings.NewReader("x")); err == nil {
		t.Error("no clamd: no error")
	}
	if _, err := parse("stream: Size limit exceeded ERROR"); err == nil {
		t.Error("error reply: no error")
	}
}
