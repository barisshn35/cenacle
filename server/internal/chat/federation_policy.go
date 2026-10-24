// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/audit"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// CodeFederationDenied: the installation's federation policy does not allow
// the other server.
const CodeFederationDenied = "federation_not_allowed"

var serverPattern = regexp.MustCompile(`^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$`)

// serverHost is the host (and port, if any) of a server address.
func serverHost(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Host)
}

// serverListed: a host matches an entry with or without its port; *.example.com
// covers the subdomains of example.com.
func serverListed(host string, servers []string) bool {
	name := host
	if i := strings.LastIndexByte(host, ':'); i > 0 && !strings.Contains(host[i:], "]") {
		name = host[:i]
	}
	for _, s := range servers {
		if rest, ok := strings.CutPrefix(s, "*."); ok {
			if strings.HasSuffix(name, "."+rest) || strings.HasSuffix(host, "."+rest) {
				return true
			}
		} else if s == host || s == name {
			return true
		}
	}
	return false
}

func federationAllows(mode string, servers []string, host string) bool {
	switch mode {
	case "allow":
		return serverListed(host, servers)
	case "deny":
		return !serverListed(host, servers)
	}
	return true
}

// serverAllowed reports whether the federation policy allows a server address.
func serverAllowed(ctx context.Context, q store.Querier, address string) (bool, error) {
	p, err := q.GetFederationPolicy(ctx)
	if err != nil {
		return false, err
	}
	return federationAllows(p.FederationMode, p.FederationServers, serverHost(address)), nil
}

func federationDenied(w http.ResponseWriter, r *http.Request, address string) {
	forbidden(w, r, CodeFederationDenied, "This server's policy does not allow connecting to "+serverHost(address)+".")
}

func connectionPolicyAPI(c store.FederationConnection) api.ConnectionPolicy {
	return api.ConnectionPolicy{ReceiveMessages: c.ReceiveMessages, ReceiveReactions: c.ReceiveReactions,
		ReceiveEdits: c.ReceiveEdits, RequestsPerMinute: int(c.RequestsPerMinute)}
}

// takes reports whether a connection's policy takes in an event of this type.
func takes(c store.FederationConnection, typ string) bool {
	switch typ {
	case "message.created":
		return c.ReceiveMessages
	case "message.updated", "message.deleted":
		return c.ReceiveEdits
	case "reaction.added", "reaction.removed":
		return c.ReceiveReactions
	}
	return true
}

// overRate counts a request of a connection and reports whether it is over
// the connection's limit, with how long to wait.
func (h *Handlers) overRate(ctx context.Context, c store.FederationConnection) (bool, time.Duration, error) {
	if h.Limiter == nil {
		return false, 0, nil
	}
	n, wait, err := h.Limiter.Hit(ctx, "cenacle:rl:federation:"+uuid(c.ID).String(), time.Minute)
	if err != nil {
		return false, 0, err
	}
	return n > int64(c.RequestsPerMinute), wait, nil
}

// GetFederationPolicy implements api.ServerInterface.
func (h *Handlers) GetFederationPolicy(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p) {
		return
	}
	pol, err := h.Queries.GetFederationPolicy(r.Context())
	if err != nil {
		h.unavailable(w, r, "get federation policy", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, api.FederationPolicy{Mode: api.FederationPolicyMode(pol.FederationMode), Servers: pol.FederationServers})
}

// SetFederationPolicy implements api.ServerInterface.
func (h *Handlers) SetFederationPolicy(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p) {
		return
	}
	var in api.FederationPolicy
	if !decode(w, r, &in) {
		return
	}
	if !in.Mode.Valid() {
		badRequest(w, r, "mode is open, allow or deny.")
		return
	}
	servers := []string{}
	for _, s := range in.Servers {
		s = strings.ToLower(strings.TrimSpace(s))
		if s == "" || slices.Contains(servers, s) {
			continue
		}
		if len(s) > 253 || !serverPattern.MatchString(s) {
			badRequest(w, r, s+" is not a host name.")
			return
		}
		servers = append(servers, s)
	}
	if len(servers) > 500 {
		badRequest(w, r, "At most 500 servers.")
		return
	}
	if err := h.Queries.SetFederationPolicy(r.Context(), store.SetFederationPolicyParams{
		FederationMode: string(in.Mode), FederationServers: servers,
	}); err != nil {
		h.unavailable(w, r, "set federation policy", err)
		return
	}
	h.Audit.Record(r.Context(), audit.Event{Actor: p.User.ID, Action: audit.FederationPolicyChanged, IP: p.IP,
		Detail: map[string]any{"mode": in.Mode, "servers": servers}})
	httpx.WriteJSON(w, http.StatusOK, api.FederationPolicy{Mode: in.Mode, Servers: servers})
}
