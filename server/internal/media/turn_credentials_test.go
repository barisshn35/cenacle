// SPDX-License-Identifier: AGPL-3.0-only
package media

import (
	"crypto/rand"
	"encoding/base64"
	"net"
	"net/netip"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestTURNCredentialsAndRelayTarget(t *testing.T) {
	entropy := make([]byte, 32)
	if _, err := rand.Read(entropy); err != nil {
		t.Fatal(err)
	}
	secret := base64.RawStdEncoding.EncodeToString(entropy)
	now := time.Unix(1804442400, 0)
	participant := uuid.NewString()
	server, err := TURNServerCredentials(secret, []string{"turns:chat.invalid:5349?transport=tcp"}, participant, now)
	if err != nil {
		t.Fatal(err)
	}
	id, fresh, valid := verifyTURNUsername(secret, server.Username, now)
	if !valid || !fresh || id != participant {
		t.Fatal("valid credential rejected")
	}
	if _, fresh, valid = verifyTURNUsername(secret, server.Username, now.Add(11*time.Minute)); !valid || fresh {
		t.Fatal("expiry not detected")
	}
	changed := server.Username[:len(server.Username)-1] + "!"
	if _, _, valid = verifyTURNUsername(secret, changed, now); valid {
		t.Fatal("modified username accepted")
	}
	relay := &turnRuntime{target: netip.MustParseAddrPort("192.0.2.1:7882")}
	if !relay.allowedTarget(&net.UDPAddr{IP: net.ParseIP("192.0.2.1"), Port: 7882}) {
		t.Fatal("media target rejected")
	}
	for _, addr := range []string{"192.0.2.1:22", "192.0.2.2:7882", "127.0.0.1:7882", "169.254.169.254:80"} {
		target, err := net.ResolveUDPAddr("udp", addr)
		if err != nil {
			t.Fatal(err)
		}
		if relay.allowedTarget(target) {
			t.Errorf("relay allowed %s", addr)
		}
	}
}
