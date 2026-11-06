// SPDX-License-Identifier: AGPL-3.0-only
package chat

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/netip"
	"time"

	guuid "github.com/google/uuid"

	"github.com/Cenacle-TR/cenacle/server/internal/events"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/media"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// ServeMediaControl is mounted on a separate internal listener. The public
// router never mounts it. Signatures and network authorization are both needed.
func (h *Handlers) ServeMediaControl(w http.ResponseWriter, r *http.Request) {
	if h.Calls == nil || r.Method != http.MethodPost || r.URL.Path != "/control" {
		http.NotFound(w, r)
		return
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		http.Error(w, "denied", http.StatusForbidden)
		return
	}
	address, err := netip.ParseAddr(host)
	if err != nil {
		http.Error(w, "denied", http.StatusForbidden)
		return
	}
	address = address.Unmap()
	allowed := false
	for _, prefix := range h.Calls.Config.InternalCIDRs {
		if prefix.Contains(address) {
			allowed = true
			break
		}
	}
	if !allowed || r.Header.Get("Content-Type") != "application/jose" {
		http.Error(w, "denied", http.StatusForbidden)
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8192))
	if err != nil {
		http.Error(w, "denied", http.StatusBadRequest)
		return
	}
	control, err := media.VerifyControl(h.Calls.Config.ControlPublic, string(raw), time.Now())
	if err != nil {
		http.Error(w, "denied", http.StatusUnauthorized)
		return
	}
	fresh, err := h.Calls.Cache.Once(r.Context(), "cenacle:media:callback:"+control.ID, 120*time.Second)
	if err != nil {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	if !fresh {
		http.Error(w, "replayed", http.StatusConflict)
		return
	}
	policy, err := h.applyMediaControl(r.Context(), control)
	if err != nil {
		http.Error(w, "admission denied", http.StatusForbidden)
		return
	}
	httpx.WriteJSON(w, 200, policy)
}

func (h *Handlers) applyMediaControl(ctx context.Context, m media.Control) (media.AdmissionPolicy, error) {
	var policy media.AdmissionPolicy
	if m.Action == "health" {
		if err := h.Calls.Cache.Check(ctx); err != nil {
			return policy, err
		}
		if _, err := h.Queries.CountOpenCalls(ctx); err != nil {
			return policy, err
		}
		return media.AdmissionPolicy{Allowed: true, MaxBitrate: 2500000, MaxParticipants: 8}, nil
	}
	callID, _ := guuid.Parse(m.CallID)
	userID, _ := guuid.Parse(m.UserID)
	sessionID, _ := guuid.Parse(m.SessionID)
	participantID, _ := guuid.Parse(m.ParticipantID)
	generation, _ := guuid.Parse(m.NodeGeneration)
	node, err := h.Calls.node(ctx)
	if err != nil || node != pgUUID(generation) {
		return policy, media.ErrAdmission
	}
	if h.Sessions == nil {
		return policy, media.ErrAdmission
	}
	active, err := h.Sessions.SessionActive(ctx, pgUUID(sessionID))
	if err != nil || !active {
		return policy, media.ErrAdmission
	}
	err = h.inTx(ctx, func(q *store.Queries) error {
		call, e := q.LockCall(ctx, pgUUID(callID))
		if e != nil {
			return e
		}
		permitted, e := q.CallAdmissionAllowed(ctx, store.CallAdmissionAllowedParams{CallID: call.ID, ParticipantID: pgUUID(participantID), UserID: pgUUID(userID), SessionID: pgUUID(sessionID), NodeGeneration: pgUUID(generation)})
		if e != nil {
			return e
		}
		if !permitted {
			return media.ErrAdmission
		}
		channel, e := q.GetChannel(ctx, call.ChannelID)
		if e != nil {
			return e
		}
		settings, e := q.GetCallSettings(ctx, channel.WorkspaceID)
		if e != nil {
			return e
		}
		participant, e := q.GetOpenUserCallParticipant(ctx, pgUUID(userID))
		if e != nil {
			return e
		}
		if participant.ID != pgUUID(participantID) || m.TransportGeneration < participant.TransportGeneration {
			return media.ErrAdmission
		}
		policy = media.AdmissionPolicy{Allowed: true, MaxBitrate: int(settings.CallsMaxBitrate), MaxParticipants: int(settings.CallsMaxParticipants)}
		switch m.Action {
		case "authorize":
			return nil
		case "joined":
			if participant.State == "connected" && participant.TransportGeneration == m.TransportGeneration {
				return nil
			}
			if participant.TransportGeneration > m.TransportGeneration {
				return media.ErrAdmission
			}
			if _, e = q.ConnectCallParticipant(ctx, store.ConnectCallParticipantParams{ID: participant.ID, CallID: call.ID, TransportGeneration: m.TransportGeneration}); e != nil {
				return e
			}
			kind := events.CallJoined
			if call.State == "active" && !call.StartedAt.Valid {
				call, e = q.StartConnectedCall(ctx, call.ID)
				kind = events.CallStarted
			} else {
				call, e = q.BumpCallRevision(ctx, call.ID)
			}
			if e != nil {
				return e
			}
			return emitCall(ctx, q, call, kind)
		case "disconnected":
			if participant.State != "connected" {
				return nil
			}
			if _, e = q.ReconnectCallParticipant(ctx, store.ReconnectCallParticipantParams{ID: participant.ID, CallID: call.ID, TransportGeneration: m.TransportGeneration}); e != nil {
				return e
			}
		case "left":
			if participant.State == "reserved" {
				_, e = q.ForceLeaveCallUser(ctx, store.ForceLeaveCallUserParams{CallID: call.ID, UserID: participant.UserID})
			} else {
				_, e = q.LeaveCallParticipant(ctx, store.LeaveCallParticipantParams{ID: participant.ID, CallID: call.ID, TransportGeneration: m.TransportGeneration})
			}
			if e != nil {
				return e
			}
		}
		count, e := q.CountOpenCallParticipants(ctx, call.ID)
		if e != nil {
			return e
		}
		if count == 0 {
			_, e = endCall(ctx, q, call, "empty")
			return e
		}
		call, e = q.BumpCallRevision(ctx, call.ID)
		if e != nil {
			return e
		}
		return emitCall(ctx, q, call, events.CallLeft)
	})
	return policy, err
}

// RunCallReconciler closes abandoned reservations, expired ringing and calls
// owned by a dead node generation. Multiple chat replicas serialize on each
// call row; only the winner writes the terminal event.
func (h *Handlers) RunCallReconciler(ctx context.Context) {
	if h.Calls == nil {
		return
	}
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	cursor := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sweepCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
			calls, err := h.Queries.ListOpenCalls(sweepCtx)
			if err == nil && len(calls) > 0 {
				start := cursor % len(calls)
				var failed error
				for i := range calls {
					cursor = (start + i + 1) % len(calls)
					candidate := calls[(start+i)%len(calls)]
					err = h.inTx(sweepCtx, func(q *store.Queries) error {
						c, e := q.LockCall(sweepCtx, candidate.ID)
						if e != nil || c.EndedAt.Valid {
							return e
						}
						node, nodeErr := h.Calls.node(sweepCtx)
						reason := ""
						if nodeErr != nil || node != c.NodeGeneration {
							reason = "node_lost"
						} else if c.State == "ringing" && c.RingUntil.Valid && !c.RingUntil.Time.After(time.Now()) {
							reason = "missed"
						}
						if reason != "" {
							_, e = endCall(sweepCtx, q, c, reason)
							return e
						}
						expired, e := q.ExpireDisconnectedCallParticipants(sweepCtx, c.ID)
						if e != nil {
							return e
						}
						participants, e := q.ListCallParticipants(sweepCtx, c.ID)
						if e != nil {
							return e
						}
						for _, participant := range participants {
							if participant.LeftAt.Valid {
								continue
							}
							permitted, e := q.CallAdmissionAllowed(sweepCtx, store.CallAdmissionAllowedParams{CallID: c.ID, ParticipantID: participant.ID, UserID: participant.UserID, SessionID: participant.SessionID, NodeGeneration: c.NodeGeneration})
							if e != nil {
								return e
							}
							if permitted && h.Sessions != nil {
								permitted, e = h.Sessions.SessionActive(sweepCtx, participant.SessionID)
								if e != nil {
									return e
								}
							}
							if !permitted || h.Sessions == nil {
								removed, e := q.ForceLeaveCallUser(sweepCtx, store.ForceLeaveCallUserParams{CallID: c.ID, UserID: participant.UserID})
								if e != nil {
									return e
								}
								expired += removed
							}
						}
						count, e := q.CountOpenCallParticipants(sweepCtx, c.ID)
						if e != nil {
							return e
						}
						if count == 0 {
							_, e = endCall(sweepCtx, q, c, "empty")
							return e
						}
						if expired > 0 {
							c, e = q.BumpCallRevision(sweepCtx, c.ID)
							if e != nil {
								return e
							}
							return emitCall(sweepCtx, q, c, events.CallLeft)
						}
						return nil
					})
					if err != nil {
						// One call's failure must not hold up the others; only a spent sweep stops.
						failed = err
						if sweepCtx.Err() != nil {
							break
						}
					}
				}
				err = failed
			}
			cancel()
			if err != nil {
				h.Log.WarnContext(ctx, "call reconciliation unavailable")
			}
		}
	}
}
