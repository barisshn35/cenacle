// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"testing"
	"time"
)

func TestNetworks(t *testing.T) {
	nets, err := ParseNetworks([]string{"10.0.0.0/8", "192.168.1.7", "2001:db8::/32"})
	if err != nil {
		t.Fatal(err)
	}
	for ip, want := range map[string]bool{
		"10.2.3.4": true, "192.168.1.7": true, "192.168.1.8": false, "2001:db8::1": true,
		"::ffff:10.0.0.1": true, "8.8.8.8": false, "not-an-ip": false,
	} {
		if got := InNetworks(ip, nets); got != want {
			t.Errorf("InNetworks(%s) = %v", ip, got)
		}
	}
	if !InNetworks("8.8.8.8", nil) {
		t.Error("no networks should allow everyone")
	}
	if _, err := ParseNetworks([]string{"10.0.0.0/33"}); err == nil {
		t.Error("a bad range was accepted")
	}
}

func TestStricter(t *testing.T) {
	for _, c := range []struct{ a, b, want time.Duration }{
		{0, 0, 0}, {time.Hour, 0, time.Hour}, {0, time.Minute, time.Minute}, {time.Hour, time.Minute, time.Minute},
	} {
		if got := stricter(c.a, c.b); got != c.want {
			t.Errorf("stricter(%v, %v) = %v", c.a, c.b, got)
		}
	}
}
