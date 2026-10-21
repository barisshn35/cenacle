// SPDX-License-Identifier: Apache-2.0

package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// Close codes of the protocol (4000-4999 are for applications).
const (
	CloseInvalidTicket websocket.StatusCode = 4001
	CloseSessionEnded  websocket.StatusCode = 4003
	CloseTooSlow       websocket.StatusCode = 4008
)

var errInvalidTicket = errors.New("invalid ticket")

// Settings of a connection; tests shorten them.
type Settings struct {
	// Heartbeat is the ping interval. Proxies must allow at least twice as
	// much idle time (Caddy has no WebSocket idle timeout).
	Heartbeat time.Duration
	// SessionCheck is how often the session behind a connection is re-checked.
	SessionCheck time.Duration
	// QueueSize bounds the events waiting for a slow client.
	QueueSize int
	// MaxBacklog is the most events sent when resuming; more means resync.
	MaxBacklog int64
}

// DefaultSettings are used in production.
var DefaultSettings = Settings{
	Heartbeat:    25 * time.Second,
	SessionCheck: time.Minute,
	QueueSize:    256,
	MaxBacklog:   500,
}

// SessionChecker tells whether a session is still active.
type SessionChecker interface {
	SessionActive(ctx context.Context, id pgtype.UUID) (bool, error)
}

// MembershipSource lists the channels and workspaces a user belongs to.
type MembershipSource interface {
	ListMemberChannelIDs(ctx context.Context, userID pgtype.UUID) ([]store.ListMemberChannelIDsRow, error)
	ListUserWorkspaces(ctx context.Context, userID pgtype.UUID) ([]store.ListUserWorkspacesRow, error)
}

// Handler serves the ticket endpoint and the WebSocket.
type Handler struct {
	Hub       *Hub
	Tickets   TicketStore
	Sessions  SessionChecker
	Members   MembershipSource
	Cookies   auth.Cookies
	PublicURL *url.URL
	Settings  Settings
	Log       *slog.Logger
}

// CreateWsTicket implements api.ServerInterface.
func (h *Handler) CreateWsTicket(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	token, err := issueTicket(r.Context(), h.Tickets, ticket{SessionID: p.Session.ID, UserID: p.User.ID})
	if err != nil {
		h.Log.ErrorContext(r.Context(), "issue websocket ticket", "error", err,
			"request_id", httpx.RequestIDFrom(r.Context()))
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusServiceUnavailable, Code: httpx.CodeUnavailable})
		return
	}
	type response struct {
		Ticket    string `json:"ticket"`
		ExpiresIn int    `json:"expires_in"`
	}
	httpx.WriteJSON(w, http.StatusCreated, response{Ticket: token, ExpiresIn: int(TicketTTL / time.Second)})
}

// frame is a message to the client.
type frame struct {
	Op          string          `json:"op"`
	ID          string          `json:"id,omitempty"`
	Type        string          `json:"type,omitempty"`
	Data        json.RawMessage `json:"data,omitempty"`
	LastEventID string          `json:"last_event_id,omitempty"`
	HeartbeatMs int64           `json:"heartbeat_ms,omitempty"`
}

// client is one connection's queue between the hub and its writer.
type client struct {
	queue  chan events.Event
	resync chan struct{}

	mu      sync.Mutex
	tooSlow bool
	slow    chan struct{}
}

func newClient(size int) *client {
	return &client{
		queue:  make(chan events.Event, size),
		resync: make(chan struct{}, 1),
		slow:   make(chan struct{}),
	}
}

// deliver never blocks the hub: a client whose queue is full is closed and
// resumes after reconnecting.
func (c *client) deliver(ev events.Event) {
	select {
	case c.queue <- ev:
	default:
		c.mu.Lock()
		if !c.tooSlow {
			c.tooSlow = true
			close(c.slow)
		}
		c.mu.Unlock()
	}
}

func (c *client) requestResync() {
	select {
	case c.resync <- struct{}{}:
	default:
	}
}

// ServeWS upgrades GET /ws?ticket=...&last_event_id=... to a WebSocket.
func (h *Handler) ServeWS(w http.ResponseWriter, r *http.Request) {
	// The server's read and write timeouts are meant for plain requests and
	// stay on the connection after the upgrade: clear them.
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})

	// The browser sends the Origin; only the app itself may connect.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{h.PublicURL.Host},
	})
	if err != nil {
		return // Accept has answered the request
	}
	defer func() { _ = conn.CloseNow() }()
	ctx := r.Context()
	log := h.Log.With("request_id", httpx.RequestIDFrom(ctx))

	t, err := redeemTicket(ctx, h.Tickets, r.URL.Query().Get("ticket"))
	if err != nil {
		_ = conn.Close(CloseInvalidTicket, "invalid or expired ticket")
		return
	}
	if active, err := h.Sessions.SessionActive(ctx, t.SessionID); err != nil || !active {
		_ = conn.Close(CloseSessionEnded, "session ended")
		return
	}

	// Register before reading the backlog, so no event falls between the two;
	// events sent twice are skipped by id below.
	c := newClient(h.Settings.QueueSize)
	h.Hub.add(c)
	defer h.Hub.remove(c)

	aud, err := h.audience(ctx, t.UserID)
	if err != nil {
		log.WarnContext(ctx, "websocket memberships", "error", err)
		_ = conn.Close(websocket.StatusTryAgainLater, "memberships unavailable")
		return
	}
	start, backlog, resync, err := h.startingPoint(ctx, r.URL.Query().Get("last_event_id"))
	if err != nil {
		log.WarnContext(ctx, "websocket start", "error", err)
		_ = conn.Close(websocket.StatusTryAgainLater, "events unavailable")
		return
	}

	ctx = conn.CloseRead(ctx) // clients do not send messages; this handles pings and close
	send := func(f frame) error {
		wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		b, _ := json.Marshal(f)
		return conn.Write(wctx, websocket.MessageText, b)
	}

	if err := send(frame{Op: "hello", LastEventID: start.String(), HeartbeatMs: h.Settings.Heartbeat.Milliseconds()}); err != nil {
		return
	}
	if resync {
		if err := send(frame{Op: "resync"}); err != nil {
			return
		}
	}
	sent := start
	forward := func(ev events.Event) error {
		id, err := events.ParseID(ev.ID)
		if err != nil || !sent.Less(id) {
			return nil // already sent
		}
		sent = id
		if !aud.allows(ev) {
			return nil
		}
		return send(frame{Op: "event", ID: ev.ID, Type: ev.Type, Data: ev.Data})
	}
	for _, ev := range backlog {
		if err := forward(ev); err != nil {
			return
		}
	}

	ping := time.NewTicker(h.Settings.Heartbeat)
	defer ping.Stop()
	check := time.NewTicker(h.Settings.SessionCheck)
	defer check.Stop()
	for {
		select {
		case <-ctx.Done():
			// The client left, or the server is shutting down: say goodbye
			// (a no-op when the connection is already closed).
			_ = conn.Close(websocket.StatusGoingAway, "server shutting down")
			return
		case <-c.slow:
			_ = conn.Close(CloseTooSlow, "client did not keep up; reconnect")
			return
		case <-c.resync:
			if err := send(frame{Op: "resync"}); err != nil {
				return
			}
		case ev := <-c.queue:
			if err := forward(ev); err != nil {
				return
			}
		case <-ping.C:
			pctx, cancel := context.WithTimeout(ctx, h.Settings.Heartbeat)
			err := conn.Ping(pctx)
			cancel()
			if err != nil {
				return
			}
		case <-check.C:
			active, err := h.Sessions.SessionActive(ctx, t.SessionID)
			if err == nil && !active {
				_ = conn.Close(CloseSessionEnded, "session ended")
				return
			}
		}
	}
}

func (h *Handler) audience(ctx context.Context, userID pgtype.UUID) (*audience, error) {
	chs, err := h.Members.ListMemberChannelIDs(ctx, userID)
	if err != nil {
		return nil, err
	}
	wss, err := h.Members.ListUserWorkspaces(ctx, userID)
	if err != nil {
		return nil, err
	}
	a := &audience{
		user:       uuidString(userID),
		channels:   make(map[string]string, len(chs)),
		workspaces: make(map[string]bool, len(wss)),
	}
	for _, c := range chs {
		a.channels[uuidString(c.ChannelID)] = uuidString(c.WorkspaceID)
	}
	for _, w := range wss {
		a.workspaces[uuidString(w.Workspace.ID)] = true
	}
	return a, nil
}

func uuidString(id pgtype.UUID) string { return openapi_types.UUID(id.Bytes).String() }

// startingPoint decides where the event stream starts for a client: after
// its last_event_id when every event since is available, otherwise at the
// current end of the log with a resync.
func (h *Handler) startingPoint(ctx context.Context, lastEventID string) (events.ID, []events.Event, bool, error) {
	st, err := h.Hub.Log.State(ctx)
	if err != nil {
		return events.ID{}, nil, false, err
	}
	if lastEventID == "" {
		return st.Last, nil, false, nil
	}
	after, err := events.ParseID(lastEventID)
	if err != nil {
		return st.Last, nil, true, nil
	}
	backlog, err := h.Hub.Log.Since(ctx, after, h.Settings.MaxBacklog)
	if errors.Is(err, events.ErrGap) {
		return st.Last, nil, true, nil
	}
	if err != nil {
		return events.ID{}, nil, false, err
	}
	return after, backlog, false, nil
}
