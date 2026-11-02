// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/audit"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// CodeAdminNetwork: the administration was used from a network the session
// policy does not allow.
const CodeAdminNetwork = "admin_network"

// ErrNetworkNotAllowed: the session policy does not let this address sign in.
var ErrNetworkNotAllowed = errors.New("sign-in from this network is not allowed")

// SessionPolicy is what installation administrators set over the operator's
// limits (Sessions.IdleTimeout and MaxAge): the stricter of the two applies.
type SessionPolicy struct {
	MaxAge, IdleTimeout           time.Duration
	GuestMaxAge, GuestIdleTimeout time.Duration
	// AdminNetworks may use the system console and instance settings, and
	// SignInNetworks may sign in; empty: every network.
	AdminNetworks, SignInNetworks []netip.Prefix
}

// policyTTL is how long a read policy is used; other instances of the server
// follow a change within this time.
const policyTTL = 10 * time.Second

type policyCache struct {
	mu     sync.Mutex
	policy SessionPolicy
	at     time.Time
}

// Policy returns the current session policy (read at most every policyTTL).
func (s *Sessions) Policy(ctx context.Context) (SessionPolicy, error) {
	s.cache.mu.Lock()
	defer s.cache.mu.Unlock()
	if !s.cache.at.IsZero() && time.Since(s.cache.at) < policyTTL {
		return s.cache.policy, nil
	}
	row, err := s.Queries.GetSessionPolicy(ctx)
	if err != nil {
		return SessionPolicy{}, fmt.Errorf("get session policy: %w", err)
	}
	p := SessionPolicy{
		MaxAge:           time.Duration(row.SessionMaxHours) * time.Hour,
		IdleTimeout:      time.Duration(row.SessionIdleMinutes) * time.Minute,
		GuestMaxAge:      time.Duration(row.GuestSessionMaxHours) * time.Hour,
		GuestIdleTimeout: time.Duration(row.GuestIdleMinutes) * time.Minute,
		AdminNetworks:    prefixes(row.AdminNetworks),
		SignInNetworks:   prefixes(row.SigninNetworks),
	}
	s.cache.policy, s.cache.at = p, time.Now()
	return p, nil
}

// PolicyChanged makes the next request read the policy again.
func (s *Sessions) PolicyChanged() {
	s.cache.mu.Lock()
	s.cache.at = time.Time{}
	s.cache.mu.Unlock()
}

// ParseNetworks reads addresses and CIDR ranges ("10.0.0.0/8", "2001:db8::1").
func ParseNetworks(in []string) ([]netip.Prefix, error) {
	out := make([]netip.Prefix, 0, len(in))
	for _, v := range in {
		if p, err := netip.ParsePrefix(v); err == nil {
			out = append(out, p.Masked())
			continue
		}
		a, err := netip.ParseAddr(v)
		if err != nil {
			return nil, fmt.Errorf("%q is not an address or a CIDR range", v)
		}
		out = append(out, netip.PrefixFrom(a, a.BitLen()))
	}
	return out, nil
}

func prefixes(in []string) []netip.Prefix {
	out, _ := ParseNetworks(in) // stored lists were checked when they were set
	return out
}

// InNetworks reports whether ip is in one of the networks (any when there are none).
func InNetworks(ip string, networks []netip.Prefix) bool {
	if len(networks) == 0 {
		return true
	}
	a, err := netip.ParseAddr(ip)
	if err != nil {
		return false
	}
	a = a.Unmap()
	for _, n := range networks {
		if n.Contains(a) {
			return true
		}
	}
	return false
}

// stricter is the smaller limit of two (0: no limit).
func stricter(a, b time.Duration) time.Duration {
	switch {
	case a <= 0:
		return b
	case b <= 0:
		return a
	}
	return min(a, b)
}

// Limits are the four intervals the session queries apply: the operator's
// limits and the administrator's session policy, whichever is stricter.
type Limits struct{ Idle, GuestIdle, MaxAge, GuestMaxAge pgtype.Interval }

// Limits returns the limits a session must be within to be used; everything
// that hangs on a session (push subscriptions) applies them too.
func (s *Sessions) Limits(ctx context.Context) (Limits, error) {
	p, err := s.Policy(ctx)
	if err != nil {
		return Limits{}, err
	}
	at := func(operator, admin time.Duration) pgtype.Interval {
		return interval(orNoLimit(stricter(operator, admin)))
	}
	return Limits{
		Idle:        at(s.IdleTimeout, p.IdleTimeout),
		GuestIdle:   at(s.IdleTimeout, stricter(p.IdleTimeout, p.GuestIdleTimeout)),
		MaxAge:      at(s.MaxAge, p.MaxAge),
		GuestMaxAge: at(s.MaxAge, stricter(p.MaxAge, p.GuestMaxAge)),
	}, nil
}

// ListUserSessions returns a user's usable sessions, most recently used first.
func (s *Sessions) ListUserSessions(ctx context.Context, userID pgtype.UUID) ([]store.Session, error) {
	l, err := s.Limits(ctx)
	if err != nil {
		return nil, err
	}
	return s.Queries.ListUserSessions(ctx, store.ListUserSessionsParams{
		UserID: userID, IdleTimeout: l.Idle, GuestIdleTimeout: l.GuestIdle, MaxAge: l.MaxAge, GuestMaxAge: l.GuestMaxAge,
	})
}

func (h *Handlers) sessionPolicyAPI(w http.ResponseWriter, r *http.Request, p Principal) {
	row, err := h.Users.GetSessionPolicy(r.Context())
	if err != nil {
		h.unavailable(w, r, "get session policy", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, api.SessionPolicy{
		SessionMaxHours: int(row.SessionMaxHours), SessionIdleMinutes: int(row.SessionIdleMinutes),
		GuestSessionMaxHours: int(row.GuestSessionMaxHours), GuestIdleMinutes: int(row.GuestIdleMinutes),
		AdminNetworks: row.AdminNetworks, SigninNetworks: row.SigninNetworks,
		OperatorMaxHours:    ptr(int(h.Sessions.MaxAge / time.Hour)),
		OperatorIdleMinutes: ptr(int(h.Sessions.IdleTimeout / time.Minute)),
		YourAddress:         ptr(p.IP),
	})
}

// GetSessionPolicy implements api.ServerInterface.
func (h *Handlers) GetSessionPolicy(w http.ResponseWriter, r *http.Request) {
	if p, ok := h.requireInstanceAdmin(w, r); ok {
		h.sessionPolicyAPI(w, r, p)
	}
}

// SetSessionPolicy implements api.ServerInterface.
func (h *Handlers) SetSessionPolicy(w http.ResponseWriter, r *http.Request) {
	p, ok := h.requireInstanceAdmin(w, r)
	if !ok {
		return
	}
	var in api.SessionPolicy
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	bad := func(detail string) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadRequest, Code: httpx.CodeBadRequest, Detail: detail})
	}
	if err := dec.Decode(&in); err != nil {
		bad("The body is not a session policy.")
		return
	}
	hours := func(v int) bool { return v >= 0 && v <= 87600 }
	minutes := func(v int) bool { return v >= 0 && v <= 525600 }
	if !hours(in.SessionMaxHours) || !hours(in.GuestSessionMaxHours) || !minutes(in.SessionIdleMinutes) || !minutes(in.GuestIdleMinutes) {
		bad("Lifetimes are 0 to 87600 hours and idle times 0 to 525600 minutes.")
		return
	}
	clean := func(in []string) ([]string, error) {
		if len(in) > 100 {
			return nil, errors.New("at most 100 networks")
		}
		nets, err := ParseNetworks(in)
		if err != nil {
			return nil, err
		}
		out := make([]string, 0, len(nets))
		for _, n := range nets {
			out = append(out, n.String())
		}
		return out, nil
	}
	adminNets, err := clean(in.AdminNetworks)
	if err == nil {
		in.SigninNetworks, err = clean(in.SigninNetworks)
	}
	if err != nil {
		bad(err.Error() + ".")
		return
	}
	// A list that leaves out the administrator's own address would lock them out.
	parsed, _ := ParseNetworks(adminNets)
	if !InNetworks(p.IP, parsed) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadRequest, Code: CodeAdminNetwork,
			Detail: "The administration networks must include your address, " + p.IP + "."})
		return
	}
	parsed, _ = ParseNetworks(in.SigninNetworks)
	if !InNetworks(p.IP, parsed) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadRequest, Code: CodeAdminNetwork,
			Detail: "The sign-in networks must include your address, " + p.IP + "."})
		return
	}
	if err := h.Users.SetSessionPolicy(r.Context(), store.SetSessionPolicyParams{
		SessionMaxHours: int32(in.SessionMaxHours), SessionIdleMinutes: int32(in.SessionIdleMinutes), //nolint:gosec // checked above
		GuestSessionMaxHours: int32(in.GuestSessionMaxHours), GuestIdleMinutes: int32(in.GuestIdleMinutes), //nolint:gosec // checked above
		AdminNetworks: adminNets, SigninNetworks: in.SigninNetworks,
	}); err != nil {
		h.unavailable(w, r, "save the session policy", err)
		return
	}
	h.Sessions.PolicyChanged()
	h.Audit.Record(r.Context(), audit.Event{
		Actor: p.User.ID, Action: audit.SessionPolicyChanged, IP: p.IP,
		Detail: map[string]any{
			"session_max_hours": in.SessionMaxHours, "session_idle_minutes": in.SessionIdleMinutes,
			"guest_session_max_hours": in.GuestSessionMaxHours, "guest_idle_minutes": in.GuestIdleMinutes,
			"admin_networks": adminNets, "signin_networks": in.SigninNetworks,
		},
	})
	h.sessionPolicyAPI(w, r, p)
}

func ptr[T any](v T) *T { return &v }
