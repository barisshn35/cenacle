// SPDX-License-Identifier: AGPL-3.0-only

package e2e_test

import (
	"encoding/hex"
	"encoding/pem"
	"strings"
	"testing"

	"github.com/Cenacle-TR/cenacle/server/internal/e2e"
)

// A vector made by web/src/app/e2e/recovery.ts (WebCrypto): the server opens
// what browsers seal.
const (
	vectorPKCS8  = "308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b02010104209788dce685331c90cfce5911d482d685daaf8daba08a84ba9051f3d93fbdf104a144034200041e133afbc6078d9d01ee6afcf96b76b3d21d3673170ddfb78ba1a1a3e27e22ae36e49131cdfc62b1daeaefb57e3f60c33561e8ef39dbedc5ca0ba8d2890820ff"
	vectorKey    = "25f93aaaba1ce1fc4a0577859c7916c997fbca9856b3aee62b1fa084abad2721"
	vectorEscrow = "01047e0eb05f93cfca71be83381481b90fa6f98fa52fd9634826228286edb61f4c0447c41d4a1ba906340e320aaaff11eb8f5cd13c8016331dee16ddce48594f5d6fe689e0c19513b262d61db0fa93b3304f68c6ab8c24aea26d3d4ac54dc90e634111e3c61a2e2f46a85ba95db9f50b8ace27bba66610205454212d10ef"
	vectorBackup = "014ec1f5e56966675ad70cd75328a8f967ca5df5f4dd89a9100516d243eceaf80b6b144a806321877e8cd41ea9a0d83d82a334f28561cd7e0f968d2dcc6d7fb00f4eba39d8924b4d7042acab836dd81b"
)

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestOpensWhatBrowsersSeal(t *testing.T) {
	pemKey := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: unhex(t, vectorPKCS8)})
	priv, err := e2e.ParsePrivateKey(pemKey)
	if err != nil {
		t.Fatal(err)
	}
	key, err := e2e.OpenEscrow(priv, unhex(t, vectorEscrow))
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(key) != vectorKey {
		t.Fatalf("recovery key = %x", key)
	}
	backup, err := e2e.OpenBackup(key, unhex(t, vectorBackup))
	if err != nil || !strings.Contains(string(backup), "Gizli plan") {
		t.Fatalf("backup = %s, %v", backup, err)
	}
	if len(e2e.Verifier(key)) != 32 {
		t.Error("verifier length")
	}
	// Tampering and other keys fail.
	bad := unhex(t, vectorEscrow)
	bad[len(bad)-1] ^= 1
	if _, err := e2e.OpenEscrow(priv, bad); err == nil {
		t.Error("a changed escrow blob opened")
	}
	if _, err := e2e.OpenBackup(make([]byte, 32), unhex(t, vectorBackup)); err == nil {
		t.Error("another key opened the backup")
	}
	if _, err := e2e.OpenEscrow(priv, []byte{2, 3}); err == nil {
		t.Error("garbage opened")
	}
}
