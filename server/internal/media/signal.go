// SPDX-License-Identifier: AGPL-3.0-only
package media

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const MaxSignalBytes = MaxSDPBytes + 32<<10

type Signal struct {
	Version       int             `json:"v"`
	Type          string          `json:"type"`
	RequestID     string          `json:"request_id,omitempty"`
	NegotiationID string          `json:"negotiation_id,omitempty"`
	Data          json.RawMessage `json:"data"`
}

func decodeStrict(raw []byte, out any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return errors.New("invalid signal")
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return errors.New("invalid signal")
	}
	return nil
}

func DecodeSignal(raw []byte) (Signal, error) {
	var message Signal
	if len(raw) == 0 || len(raw) > MaxSignalBytes || decodeStrict(raw, &message) != nil {
		return Signal{}, errors.New("invalid signal")
	}
	if message.Version != 1 || len(message.RequestID) > 64 || len(message.NegotiationID) > 64 || len(message.Data) == 0 {
		return Signal{}, errors.New("invalid signal")
	}
	switch message.Type {
	case "authenticate", "offer", "answer", "ice", "ice_restart", "publish", "unpublish", "subscribe", "tile", "leave":
	default:
		return Signal{}, errors.New("unknown signal")
	}
	return message, nil
}

// SignalPeer owns one transport. Handle must reject unknown data fields and
// obey context cancellation. It never receives an admission token.
type SignalPeer interface {
	Handle(context.Context, Signal) error
	Close() error
}

type SignalHandler struct {
	Origin string
	Tokens *Tokens
	Lease  *Lease
	Open   func(context.Context, Grant, func(Signal) error) (SignalPeer, error)
	// Log records refused admissions (never the token); nil logs nothing.
	Log   *slog.Logger
	once  sync.Once
	slots chan struct{}
}

func (h *SignalHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.once.Do(func() { h.slots = make(chan struct{}, 128) })
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if r.Header.Get("Origin") != h.Origin || h.Origin == "" {
		http.Error(w, "origin denied", http.StatusForbidden)
		return
	}
	if r.URL.RawQuery != "" {
		http.Error(w, "query not allowed", http.StatusBadRequest)
		return
	}
	if h.Tokens == nil || h.Lease == nil || h.Lease.Check(r.Context()) != nil || h.Open == nil {
		http.Error(w, "media unavailable", http.StatusServiceUnavailable)
		return
	}
	select {
	case h.slots <- struct{}{}:
		defer func() { <-h.slots }()
	default:
		http.Error(w, "media capacity reached", http.StatusServiceUnavailable)
		return
	}
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Time{})
	_ = controller.SetWriteDeadline(time.Time{})
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer func() { _ = conn.CloseNow() }()
	conn.SetReadLimit(8192)
	authCtx, cancelAuth := context.WithTimeout(r.Context(), 5*time.Second)
	kind, raw, err := conn.Read(authCtx)
	cancelAuth()
	if err != nil || kind != websocket.MessageText {
		return
	}
	frame, err := DecodeSignal(raw)
	var credential struct {
		Token string `json:"token"`
	}
	if err != nil || frame.Type != "authenticate" || decodeStrict(frame.Data, &credential) != nil {
		return
	}
	verifyCtx, cancelVerify := context.WithTimeout(r.Context(), 3*time.Second)
	grant, err := h.Tokens.Redeem(verifyCtx, credential.Token, h.Lease.Generation)
	credential.Token = ""
	if err == nil {
		err = h.Lease.ClaimRoom(verifyCtx, grant.CallID)
	}
	cancelVerify()
	if err != nil {
		// The token was not accepted, so nothing in it can be trusted to name anyone.
		if h.Log != nil {
			h.Log.WarnContext(r.Context(), "call admission refused")
		}
		_ = conn.Close(websocket.StatusPolicyViolation, "admission denied")
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	var writes sync.Mutex
	send := func(message Signal) error {
		raw, err := json.Marshal(message)
		if err != nil || len(raw) > MaxSignalBytes {
			return errors.New("invalid outgoing signal")
		}
		writes.Lock()
		defer writes.Unlock()
		writeCtx, writeCancel := context.WithTimeout(ctx, 5*time.Second)
		defer writeCancel()
		return conn.Write(writeCtx, websocket.MessageText, raw)
	}
	peer, err := h.Open(ctx, grant, send)
	if err != nil {
		return
	}
	defer func() { _ = peer.Close() }()
	conn.SetReadLimit(MaxSignalBytes)
	if send(Signal{Version: 1, Type: "authenticated", Data: json.RawMessage(`{}`)}) != nil {
		return
	}
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				checkCtx, checkCancel := context.WithTimeout(ctx, 2*time.Second)
				err := h.Lease.ClaimRoom(checkCtx, grant.CallID)
				checkCancel()
				if err != nil {
					cancel()
					_ = conn.CloseNow()
					return
				}
			}
		}
	}()
	go func() {
		ticker := time.NewTicker(25 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				pingCtx, pingCancel := context.WithTimeout(ctx, 5*time.Second)
				err := conn.Ping(pingCtx)
				pingCancel()
				if err != nil {
					cancel()
					_ = conn.CloseNow()
					return
				}
			}
		}
	}()
	window := time.Now()
	tokens := float64(80)
	reason := ""
	if labSignalEnded != nil {
		defer func() { labSignalEnded(peer, reason) }()
	}
	for {
		kind, raw, err = conn.Read(ctx)
		if err != nil || kind != websocket.MessageText {
			reason = fmt.Sprintf("read: %v", err)
			return
		}
		now := time.Now()
		tokens = min(80, tokens+now.Sub(window).Seconds()*20)
		window = now
		if tokens < 1 {
			reason = "rate"
			_ = conn.Close(websocket.StatusPolicyViolation, "signal rate exceeded")
			return
		}
		tokens--
		frame, err = DecodeSignal(raw)
		if err != nil || frame.Type == "authenticate" {
			_ = conn.Close(websocket.StatusPolicyViolation, "invalid signal")
			return
		}
		if frame.Type == "leave" {
			_ = peer.Handle(ctx, frame)
			return
		}
		if err := peer.Handle(ctx, frame); err != nil {
			reason = "rejected " + frame.Type + ": " + err.Error()
			_ = conn.Close(websocket.StatusPolicyViolation, "signal rejected")
			return
		}
	}
}
