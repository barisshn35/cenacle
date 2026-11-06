// SPDX-License-Identifier: AGPL-3.0-only
package app_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/Cenacle-TR/cenacle/server/internal/config"
	"github.com/Cenacle-TR/cenacle/server/internal/media"
)

// Integration tests against PostgreSQL and Valkey: go test ./internal/app -run TestCalls
func TestCallsDisabledByDefault(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	token := s.user("calls-disabled", "Caller")
	response := s.call(http.MethodPost, "/api/channels/"+s.general(token)+"/calls", token, map[string]any{"nonce": uuid.NewString()}, nil)
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("disabled start status %d", response.StatusCode)
	}
}
func TestCallsAdmissionRaceReplayAndEncryption(t *testing.T) {
	shared := newShared(t)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	generation := uuid.NewString()
	s := newStack(t, shared, options{calls: &config.Calls{Private: private, KeyID: "test-calls", NodeID: "test-media"}})
	ctx := context.Background()
	if err = shared.valkey.PutNew(ctx, "cenacle:media:node:test-media", []byte(generation), time.Minute); err != nil {
		t.Fatal(err)
	}
	starter := s.user("calls-starter", "Starter")
	channel := s.general(starter)
	if _, err = s.pool.Exec(ctx, "UPDATE workspaces SET calls_enabled = true WHERE id = $1", s.defaultWS); err != nil {
		t.Fatal(err)
	}
	nonce := uuid.NewString()
	var call struct {
		ID string `json:"id"`
	}
	response := s.call(http.MethodPost, "/api/channels/"+channel+"/calls", starter, map[string]any{"nonce": nonce}, &call)
	if response.StatusCode != http.StatusCreated || call.ID == "" {
		t.Fatalf("start status %d", response.StatusCode)
	}
	var retried struct {
		ID string `json:"id"`
	}
	response = s.call(http.MethodPost, "/api/channels/"+channel+"/calls", starter, map[string]any{"nonce": nonce}, &retried)
	if response.StatusCode != http.StatusCreated || retried.ID != call.ID {
		t.Fatal("start retry was not idempotent")
	}
	tokenPath := "/api/calls/" + call.ID + "/token"
	var admission struct {
		Token string `json:"token"`
	}
	response = s.call(http.MethodPost, tokenPath, starter, nil, &admission)
	if response.StatusCode != http.StatusOK || response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("token status %d", response.StatusCode)
	}
	verifier := media.Tokens{Public: public, KeyID: "test-calls", Issuer: s.srv.URL, Store: shared.valkey}
	if _, err = verifier.Redeem(ctx, admission.Token, generation); err != nil {
		t.Fatal("valid token rejected")
	}
	if _, err = verifier.Redeem(ctx, admission.Token, generation); err == nil {
		t.Fatal("token replay accepted")
	}
	// Starter + six reservations leaves exactly one slot.
	for i := 0; i < 6; i++ {
		token := s.user("calls-slot-"+string(rune('a'+i)), "Participant")
		if response = s.call(http.MethodPost, tokenPath, token, nil, nil); response.StatusCode != http.StatusOK {
			t.Fatalf("reserve status %d", response.StatusCode)
		}
	}
	contenders := []string{s.user("calls-race-a", "A"), s.user("calls-race-b", "B")}
	results := make(chan int, 2)
	var group sync.WaitGroup
	for _, token := range contenders {
		group.Add(1)
		go func(token string) {
			defer group.Done()
			results <- s.call(http.MethodPost, tokenPath, token, nil, nil).StatusCode
		}(token)
	}
	group.Wait()
	close(results)
	accepted, rejected := 0, 0
	for status := range results {
		switch status {
		case 200:
			accepted++
		case 409:
			rejected++
		default:
			t.Errorf("unexpected race status %d", status)
		}
	}
	if accepted != 1 || rejected != 1 {
		t.Fatalf("admissions %d, rejections %d", accepted, rejected)
	}
	if _, err = s.pool.Exec(ctx, "UPDATE channels SET encrypted = true WHERE id = $1", channel); err != nil {
		t.Fatal(err)
	}
	if response = s.call(http.MethodPost, tokenPath, starter, nil, nil); response.StatusCode != http.StatusForbidden {
		t.Fatalf("encrypted admission status %d", response.StatusCode)
	}
}

// Workspaces choose up to 16 people per call (the measured ceiling), 8 by default.
func TestCallsSettingsCeiling(t *testing.T) {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s := newStack(t, newShared(t), options{calls: &config.Calls{Private: private, KeyID: "test-calls", NodeID: "test-media"}})
	admin := s.admin()
	path := "/api/workspaces/" + s.defaultWS + "/calls/settings"
	var settings struct {
		MaxParticipants int `json:"max_participants"`
	}
	if response := s.call(http.MethodGet, path, admin, nil, &settings); response.StatusCode != http.StatusOK || settings.MaxParticipants != 8 {
		t.Fatalf("default ceiling %d (status %d)", settings.MaxParticipants, response.StatusCode)
	}
	for limit, want := range map[int]int{16: http.StatusOK, 17: http.StatusBadRequest, 1: http.StatusBadRequest} {
		body := map[string]any{"enabled": true, "guest_start": false, "max_participants": limit, "max_bitrate": 2500000}
		if response := s.call(http.MethodPut, path, admin, body, nil); response.StatusCode != want {
			t.Fatalf("max_participants %d: status %d, want %d", limit, response.StatusCode, want)
		}
	}
}
