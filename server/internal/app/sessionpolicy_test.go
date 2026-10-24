// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/barisshn35/cenacle/server/internal/api"
)

func TestSessionPolicy(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	misafir := s.user("sub-g", "Misafir")
	if _, err := s.pool.Exec(context.Background(), `UPDATE users SET directory_role = 'guest' WHERE display_name = 'Misafir'`); err != nil {
		t.Fatal(err)
	}
	const path = "/api/admin/session-policy"

	if status, _ := problemCode(t, s, http.MethodGet, path, ayse, nil); status != http.StatusForbidden {
		t.Errorf("member reads the policy = %d", status)
	}
	var got api.SessionPolicy
	s.call(http.MethodGet, path, admin, nil, &got)
	if got.OperatorMaxHours == nil || *got.OperatorMaxHours != 24 || got.YourAddress == nil || *got.YourAddress != "127.0.0.1" {
		t.Fatalf("policy = %+v", got)
	}

	// Networks that leave the administrator out are refused; bad ones too.
	policy := api.SessionPolicy{AdminNetworks: []string{"10.0.0.0/8"}, SigninNetworks: []string{}}
	if status, code := problemCode(t, s, http.MethodPut, path, admin, policy); status != http.StatusBadRequest || code != "admin_network" {
		t.Errorf("lock-out = %d %s", status, code)
	}
	policy.AdminNetworks = []string{"no-network"}
	if status, _ := problemCode(t, s, http.MethodPut, path, admin, policy); status != http.StatusBadRequest {
		t.Errorf("bad network = %d", status)
	}

	// Guests' sessions end after an hour, everyone's after twelve.
	policy = api.SessionPolicy{SessionMaxHours: 12, GuestSessionMaxHours: 1,
		AdminNetworks: []string{"127.0.0.1", "10.1.2.0/24"}, SigninNetworks: []string{}}
	if res := s.call(http.MethodPut, path, admin, policy, &got); res.StatusCode != http.StatusOK {
		t.Fatalf("set = %d", res.StatusCode)
	}
	if len(got.AdminNetworks) != 2 || got.AdminNetworks[0] != "127.0.0.1/32" {
		t.Errorf("networks = %v", got.AdminNetworks)
	}
	if _, err := s.pool.Exec(context.Background(), `UPDATE sessions SET created_at = now() - interval '2 hours'`); err != nil {
		t.Fatal(err)
	}
	if res := s.call(http.MethodGet, "/api/channels", misafir, nil, nil); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("guest after two hours = %d", res.StatusCode)
	}
	if res := s.call(http.MethodGet, "/api/channels", ayse, nil, nil); res.StatusCode != http.StatusOK {
		t.Errorf("member after two hours = %d", res.StatusCode)
	}

	// From another network the administration is closed, the chat is not.
	if _, err := s.pool.Exec(context.Background(), `UPDATE instance_settings SET admin_networks = '{10.1.2.0/24}'`); err != nil {
		t.Fatal(err)
	}
	s.sessions.PolicyChanged()
	if status, code := problemCode(t, s, http.MethodGet, "/api/admin/overview", admin, nil); status != http.StatusForbidden || code != "admin_network" {
		t.Errorf("console from another network = %d %s", status, code)
	}
	if res := s.call(http.MethodGet, "/api/channels", admin, nil, nil); res.StatusCode != http.StatusOK {
		t.Errorf("chat from another network = %d", res.StatusCode)
	}
}
