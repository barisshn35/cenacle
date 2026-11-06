// SPDX-License-Identifier: AGPL-3.0-only
package app_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/chat"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// Erasure, legal hold and its release, also while calls are turned off.
func TestCallsPrivacyErasureHoldReleaseWhileDisabled(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ctx := context.Background()
	admin := s.admin()
	user := s.user("call-privacy", "Call Subject")
	general := s.general(user)
	s.general(admin)
	userID := s.userID(user)
	var heldChannel struct{ ID string }
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"workspace_id": s.defaultWS, "name": "held-calls"}, &heldChannel)
	s.call(http.MethodPost, "/api/channels/"+heldChannel.ID+"/members", admin, map[string]any{"user_id": userID}, nil)
	free, held := uuid.NewString(), uuid.NewString()
	for _, item := range []struct{ id, channel string }{{free, general}, {held, heldChannel.ID}} {
		_, err := s.pool.Exec(ctx, `INSERT INTO calls(id, channel_id, created_by, nonce, state, created_at, started_at, ended_at, node_id, node_generation)
    VALUES ($1,$2,$3,$4,'ended',now()-interval '2 days',now()-interval '2 days',now()-interval '2 days' + interval '1 minute','fixture',$5)`, item.id, item.channel, userID, uuid.NewString(), uuid.NewString())
		if err != nil {
			t.Fatal(err)
		}
		if _, err = s.pool.Exec(ctx, `INSERT INTO call_participants(call_id,user_id,state,joined_at,left_at) VALUES($1,$2,'left',now()-interval '2 days',now()-interval '2 days'+interval '1 minute')`, item.id, userID); err != nil {
			t.Fatal(err)
		}
	}
	_, exported := s.download(user, "/api/me/export")
	if kinds(exported)["call_participation"] != 2 {
		t.Fatal("own call metadata missing from export")
	}
	for _, row := range exported {
		if row["kind"] != "call_participation" {
			continue
		}
		data := row["data"].(map[string]any)
		for _, secret := range []string{"session_id", "token", "node_generation", "participants", "sdp"} {
			if _, ok := data[secret]; ok {
				t.Fatalf("unexpected call export field %s", secret)
			}
		}
	}
	var hold api.LegalHold
	s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/legal-holds", admin, map[string]any{"name": "Call hold", "user_ids": []string{}, "channel_ids": []string{heldChannel.ID}}, &hold)
	if response := s.call(http.MethodPost, "/api/admin/users/"+userID+"/erase", admin, map[string]string{"confirm": "Call Subject"}, nil); response.StatusCode != http.StatusOK {
		t.Fatalf("erase status %d", response.StatusCode)
	}
	if s.count(`SELECT count(*) FROM call_participants WHERE call_id=$1`, free) != 0 {
		t.Fatal("unheld participation survived erasure")
	}
	if s.count(`SELECT count(*) FROM calls WHERE id=$1 AND created_by IS NOT NULL`, free) != 0 {
		t.Fatal("unheld initiator survived erasure")
	}
	if s.count(`SELECT count(*) FROM call_participants WHERE call_id=$1 AND redacted_at IS NOT NULL AND user_id=$2 AND session_id IS NULL`, held, userID) != 1 {
		t.Fatal("held raw record was lost or not redacted")
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET retention_days=1 WHERE id=$1`, s.defaultWS); err != nil {
		t.Fatal(err)
	}
	purger := chat.Purger{Queries: store.New(s.pool)}
	if _, err := purger.PurgeDeleted(ctx); err != nil {
		t.Fatal(err)
	}
	if s.count(`SELECT count(*) FROM calls WHERE id=$1`, held) != 1 {
		t.Fatal("hold did not preserve call")
	}
	s.call(http.MethodPost, "/api/legal-holds/"+hold.Id.String()+"/release", admin, nil, &hold)
	if _, err := purger.PurgeDeleted(ctx); err != nil {
		t.Fatal(err)
	}
	if s.count(`SELECT count(*) FROM calls WHERE id=$1`, held) != 0 {
		t.Fatal("released call exceeded retention")
	}
}
