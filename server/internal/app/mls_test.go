// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"net/http"
	"testing"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/chat"
)

func key32(b byte) []byte { return bytes.Repeat([]byte{b}, 32) }

// mlsEnvelope is an envelope with a PrivateMessage header for a group and an
// epoch (the rest is opaque to the server).
func mlsEnvelope(group string, epoch uint64, size int) string {
	b := []byte{0, 1, 0, 2, byte(len(group))}
	b = append(b, group...)
	b = binary.BigEndian.AppendUint64(b, epoch)
	b = append(b, bytes.Repeat([]byte{0xab}, size)...)
	return "mls:v1:" + base64.StdEncoding.EncodeToString(b)
}

func (s *stack) device(token, name string, sig []byte) api.E2EDevice {
	s.t.Helper()
	var d api.E2EDevice
	if res := s.call(http.MethodPost, "/api/e2e/devices", token, map[string]any{"name": name, "signature_key": sig}, &d); res.StatusCode != http.StatusCreated {
		s.t.Fatalf("register device = %d", res.StatusCode)
	}
	return d
}

func TestMLSDeliveryService(t *testing.T) {
	s := newStack(t, newShared(t), options{files: true})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")

	// Devices: a 32-byte key, a name; up to 20.
	if status, _ := problemCode(t, s, http.MethodPost, "/api/e2e/devices", ayse, map[string]any{"name": "x", "signature_key": []byte("short")}); status != http.StatusBadRequest {
		t.Errorf("short key = %d", status)
	}
	a1 := s.device(ayse, "Firefox on Linux", key32(1))
	m1 := s.device(mert, "Desktop", key32(2))
	m2 := s.device(mert, "Laptop", key32(3))
	var mine struct{ Devices []api.E2EDevice }
	s.call(http.MethodGet, "/api/e2e/devices", mert, nil, &mine)
	if len(mine.Devices) != 2 || mine.Devices[0].LastSeenAt == nil {
		t.Errorf("own devices = %+v", mine.Devices)
	}
	var theirs struct{ Devices []api.E2EDevice }
	s.call(http.MethodGet, "/api/users/"+s.userID(mert)+"/e2e/devices", ayse, nil, &theirs)
	if len(theirs.Devices) != 2 || theirs.Devices[0].LastSeenAt != nil || !bytes.Equal(theirs.Devices[0].SignatureKey, key32(2)) {
		t.Errorf("Mert's devices for Ayşe = %+v", theirs.Devices)
	}

	var vault channel
	if res := s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Vault", "visibility": "private"}, &vault); res.StatusCode != http.StatusCreated {
		t.Fatalf("create = %d", res.StatusCode)
	}
	for _, u := range []string{ayse, mert} {
		s.call(http.MethodPost, "/api/channels/"+vault.ID+"/members", admin, map[string]string{"user_id": s.userID(u)}, nil)
	}
	base := "/api/channels/" + vault.ID + "/e2e"
	// Members who do not manage the channel cannot turn encryption on.
	if status, _ := problemCode(t, s, http.MethodPost, base, ayse, map[string]any{"device_id": a1.Id, "group_info": []byte("gi-0")}); status != http.StatusForbidden {
		t.Errorf("enable by a member = %d", status)
	}
	if _, err := s.pool.Exec(t.Context(), `UPDATE channel_members SET role = 'manager' WHERE channel_id = $1 AND user_id = $2`, vault.ID, s.userID(ayse)); err != nil {
		t.Fatal(err)
	}
	// Another person's device does not count.
	if status, code := problemCode(t, s, http.MethodPost, base, ayse, map[string]any{"device_id": m1.Id, "group_info": []byte("gi-0")}); status != http.StatusForbidden || code != chat.CodeNoDevice {
		t.Errorf("enable with Mert's device = %d %s", status, code)
	}
	var g api.MLSGroup
	if res := s.call(http.MethodPost, base, ayse, map[string]any{"device_id": a1.Id, "group_info": []byte("gi-0")}, &g); res.StatusCode != http.StatusOK {
		t.Fatalf("enable = %d", res.StatusCode)
	}
	if g.Epoch != 0 || len(g.Members) != 1 || g.Members[0].DeviceId != a1.Id || string(g.GroupInfo) != "gi-0" {
		t.Errorf("group = %+v", g)
	}
	if status, _ := problemCode(t, s, http.MethodPost, base, ayse, map[string]any{"device_id": a1.Id, "group_info": []byte("again")}); status != http.StatusConflict {
		t.Errorf("enable twice = %d", status)
	}

	// Mert's devices join on their own (external commits), one epoch each.
	commit := func(token string, dev api.E2EDevice, epoch int64, joined bool, removed ...any) (int, string) {
		body := map[string]any{"device_id": dev.Id, "epoch": epoch, "commit": []byte("c" + string(rune('0'+epoch))),
			"group_info": []byte("gi"), "joined": joined}
		if len(removed) > 0 {
			body["removed"] = removed
		}
		return problemCode(t, s, http.MethodPost, base+"/commits", token, body)
	}
	if status, code := commit(mert, m1, 0, false); status != http.StatusForbidden || code != chat.CodeNoDevice {
		t.Errorf("commit from outside the group = %d %s", status, code)
	}
	if status, _ := commit(mert, m1, 0, true); status != http.StatusCreated {
		t.Errorf("join = %d", status)
	}
	// The second join made for epoch 0 comes too late.
	if status, code := commit(mert, m2, 0, true); status != http.StatusConflict || code != chat.CodeEpochConflict {
		t.Errorf("stale join = %d %s", status, code)
	}
	if status, _ := commit(mert, m2, 1, true); status != http.StatusCreated {
		t.Errorf("join at 1 = %d", status)
	}
	var commits struct{ Commits []api.MLSCommit }
	s.call(http.MethodGet, base+"/commits?from_epoch=1", ayse, nil, &commits)
	if len(commits.Commits) != 1 || commits.Commits[0].Epoch != 1 || *commits.Commits[0].DeviceId != m2.Id {
		t.Errorf("commits = %+v", commits.Commits)
	}

	// A revoked device and the devices of someone who left become stale.
	if res := s.call(http.MethodDelete, "/api/e2e/devices/"+m2.Id.String(), mert, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("revoke = %d", res.StatusCode)
	}
	s.call(http.MethodGet, base, ayse, nil, &g)
	stale := map[string]bool{}
	for _, m := range g.Members {
		stale[m.DeviceId.String()] = m.Stale
	}
	if g.Epoch != 2 || len(g.Members) != 3 || !stale[m2.Id.String()] || stale[m1.Id.String()] {
		t.Errorf("group after revoke = %+v", g)
	}
	if status, _ := commit(ayse, a1, 2, false, m2.Id); status != http.StatusCreated {
		t.Errorf("remove = %d", status)
	}
	s.call(http.MethodGet, base, ayse, nil, &g)
	if len(g.Members) != 2 {
		t.Errorf("members after remove = %+v", g.Members)
	}
	s.call(http.MethodGet, "/api/users/"+s.userID(mert)+"/e2e/devices", ayse, nil, &theirs)
	if len(theirs.Devices) != 2 || theirs.Devices[1].RevokedAt == nil || theirs.Devices[0].RevokedAt != nil {
		t.Errorf("Mert's devices after revoking one = %+v", theirs.Devices)
	}

	// Bodies: MLS envelopes only, and never in other channels.
	msgs := "/api/channels/" + vault.ID + "/messages"
	for _, body := range []string{"plain", "e2e:v1:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAAAAAAAAAAAAAAAAAA", "mls:v1:not base64!"} {
		if status, code := problemCode(t, s, http.MethodPost, msgs, mert, map[string]any{"body": body, "nonce": "mls-nonce-x" + body[:3]}); status != http.StatusBadRequest || code != chat.CodeEncrypted {
			t.Errorf("body %q = %d %s", body, status, code)
		}
	}
	envelope := mlsEnvelope(vault.ID, 3, 6000)
	if res := s.call(http.MethodPost, msgs, mert, map[string]any{"body": envelope, "nonce": "mls-nonce-1"}, nil); res.StatusCode != http.StatusCreated {
		t.Errorf("envelope = %d", res.StatusCode)
	}
	// An older epoch: the sender updates the group first; another group: refused.
	if status, code := problemCode(t, s, http.MethodPost, msgs, mert, map[string]any{"body": mlsEnvelope(vault.ID, 2, 40), "nonce": "mls-nonce-4"}); status != http.StatusConflict || code != chat.CodeEpochConflict {
		t.Errorf("old epoch = %d %s", status, code)
	}
	if status, code := problemCode(t, s, http.MethodPost, msgs, mert, map[string]any{"body": mlsEnvelope(s.general(mert), 3, 40), "nonce": "mls-nonce-5"}); status != http.StatusBadRequest || code != chat.CodeEncrypted {
		t.Errorf("another group = %d %s", status, code)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/channels/"+vault.ID+"/scheduled", mert, map[string]any{"body": envelope, "send_at": "2100-01-01T00:00:00Z"}); status != http.StatusBadRequest {
		t.Errorf("scheduled envelope = %d", status)
	}
	if status, code := problemCode(t, s, http.MethodPost, "/api/channels/"+s.general(mert)+"/messages", mert, map[string]any{"body": envelope, "nonce": "mls-nonce-2"}); status != http.StatusBadRequest || code != chat.CodeEncrypted {
		t.Errorf("envelope elsewhere = %d %s", status, code)
	}

	// Files: encrypted in the browser, kept as they are.
	uploads := "/api/channels/" + vault.ID + "/files"
	if status, code := problemCode(t, s, http.MethodPost, uploads, mert, map[string]any{"name": "a.png", "size": 10}); status != http.StatusBadRequest || code != chat.CodeEncrypted {
		t.Errorf("plain upload = %d %s", status, code)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/channels/"+s.general(mert)+"/files", mert, map[string]any{"name": "a", "size": 10, "encrypted": true}); status != http.StatusBadRequest {
		t.Errorf("encrypted upload elsewhere = %d", status)
	}
	var u upload
	if res := s.call(http.MethodPost, uploads, mert, map[string]any{"name": "secret.png", "size": 32, "content_type": "image/png", "encrypted": true}, &u); res.StatusCode != http.StatusCreated {
		t.Fatalf("encrypted upload = %d", res.StatusCode)
	}
	if u.File.Name != "encrypted" {
		t.Errorf("the name of an encrypted file = %q", u.File.Name)
	}
	if status := postForm(t, u, pngImage(t, 2, 2)[:32]); status/100 != 2 {
		t.Fatalf("upload = %d", status)
	}
	var f fileInfo
	if res := s.call(http.MethodPost, "/api/files/"+u.File.ID+"/complete", mert, nil, &f); res.StatusCode != http.StatusOK || f.ContentType != "application/octet-stream" {
		t.Errorf("complete = %d %+v", res.StatusCode, f)
	}
	if res := s.call(http.MethodPost, msgs, mert, map[string]any{"body": mlsEnvelope(vault.ID, 3, 40), "nonce": "mls-nonce-3", "file_ids": []string{u.File.ID}}, nil); res.StatusCode != http.StatusCreated {
		t.Errorf("message with an encrypted file = %d", res.StatusCode)
	}

	// Mert leaves: his device becomes stale; he cannot read the group anymore.
	if res := s.call(http.MethodDelete, "/api/channels/"+vault.ID+"/members/"+s.userID(mert), admin, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("remove Mert = %d", res.StatusCode)
	}
	s.call(http.MethodGet, base, ayse, nil, &g)
	for _, m := range g.Members {
		if m.DeviceId == m1.Id && !m.Stale {
			t.Error("the device of someone who left is not stale")
		}
	}
	if status, _ := problemCode(t, s, http.MethodGet, base, mert, nil); status != http.StatusNotFound && status != http.StatusForbidden {
		t.Errorf("group for someone who left = %d", status)
	}
}

func TestE2ERecoveryAndEscrow(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	a1 := s.device(ayse, "Browser", key32(7))
	var vault channel
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Vault"}, &vault)
	s.call(http.MethodPost, "/api/channels/"+vault.ID+"/members", admin, map[string]string{"user_id": s.userID(ayse)}, nil)
	if _, err := s.pool.Exec(t.Context(), `UPDATE channel_members SET role = 'manager' WHERE channel_id = $1 AND user_id = $2`, vault.ID, s.userID(ayse)); err != nil {
		t.Fatal(err)
	}
	if res := s.call(http.MethodPost, "/api/channels/"+vault.ID+"/e2e", ayse, map[string]any{"device_id": a1.Id, "group_info": []byte("gi")}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("enable = %d", res.StatusCode)
	}
	backups := "/api/channels/" + vault.ID + "/e2e/backups"

	var rec api.E2ERecovery
	s.call(http.MethodGet, "/api/e2e/recovery", ayse, nil, &rec)
	if rec.Set || rec.EscrowKey != nil {
		t.Errorf("recovery at first = %+v", rec)
	}
	if status, _ := problemCode(t, s, http.MethodPost, backups, ayse, map[string]any{"data": []byte("sealed")}); status != http.StatusConflict {
		t.Errorf("backup without a recovery key = %d", status)
	}
	if res := s.call(http.MethodPut, "/api/e2e/recovery", ayse, map[string]any{"verifier": key32(9)}, &rec); res.StatusCode != http.StatusOK || !rec.Set {
		t.Fatalf("set recovery = %d %+v", res.StatusCode, rec)
	}
	for i := range 3 {
		if res := s.call(http.MethodPost, backups, ayse, map[string]any{"data": []byte{byte(i), 1, 2}}, nil); res.StatusCode != http.StatusNoContent {
			t.Fatalf("backup = %d", res.StatusCode)
		}
	}
	var page struct {
		Backups []struct {
			ID   string `json:"id"`
			Data []byte `json:"data"`
		}
	}
	s.call(http.MethodGet, backups, ayse, nil, &page)
	if len(page.Backups) != 3 || page.Backups[2].Data[0] != 2 {
		t.Fatalf("backups = %+v", page.Backups)
	}
	s.call(http.MethodGet, backups+"?after="+page.Backups[0].ID, ayse, nil, &page)
	if len(page.Backups) != 2 {
		t.Errorf("backups after the first = %d", len(page.Backups))
	}

	// Escrow: only instance administrators, only P-256 keys.
	priv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	spki, _ := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if status, _ := problemCode(t, s, http.MethodPut, "/api/admin/e2e/escrow", ayse, map[string]any{"key_id": "k1", "public_key": spki}); status != http.StatusForbidden {
		t.Errorf("escrow by a member = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodPut, "/api/admin/e2e/escrow", admin, map[string]any{"key_id": "k1", "public_key": []byte("junk")}); status != http.StatusBadRequest {
		t.Errorf("junk escrow key = %d", status)
	}
	if res := s.call(http.MethodPut, "/api/admin/e2e/escrow", admin, map[string]any{"key_id": "k1", "public_key": spki}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("escrow = %d", res.StatusCode)
	}
	s.call(http.MethodGet, "/api/e2e/recovery", ayse, nil, &rec)
	if rec.EscrowKey == nil || rec.EscrowKey.KeyId != "k1" || rec.Escrowed == nil || *rec.Escrowed {
		t.Errorf("recovery with escrow = %+v", rec)
	}
	if status, code := problemCode(t, s, http.MethodPut, "/api/e2e/recovery", ayse, map[string]any{"verifier": key32(8)}); status != http.StatusBadRequest || code != chat.CodeEscrowNeeded {
		t.Errorf("recovery without escrow = %d %s", status, code)
	}
	if res := s.call(http.MethodPut, "/api/e2e/recovery", ayse, map[string]any{"verifier": key32(8), "escrow": []byte("sealed-for-k1"), "escrow_key_id": "k1"}, &rec); res.StatusCode != http.StatusOK || !*rec.Escrowed {
		t.Errorf("recovery with escrow = %d %+v", res.StatusCode, rec)
	}
	// A new recovery key deletes the old backups.
	s.call(http.MethodGet, backups, ayse, nil, &page)
	if len(page.Backups) != 0 {
		t.Errorf("old backups kept = %d", len(page.Backups))
	}
	if res := s.call(http.MethodDelete, "/api/e2e/recovery", ayse, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("delete recovery = %d", res.StatusCode)
	}
	if n := s.count(`SELECT count(*) FROM audit_events WHERE action IN ('instance.e2e_escrow_changed', 'channel.e2e_enabled', 'user.e2e_device_added')`); n != 3 {
		t.Errorf("audit events = %d", n)
	}
}
