// SPDX-License-Identifier: Apache-2.0

package cenacle

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"
)

// maxBody is the largest request body read from Cenacle.
const maxBody = 1 << 20

// verified reads a request's body and checks its signature; it answers 401
// itself when it does not verify.
func verified(w http.ResponseWriter, r *http.Request, secret string) ([]byte, bool) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return nil, false
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		http.Error(w, "body too large", http.StatusRequestEntityTooLarge)
		return nil, false
	}
	if !Verify(secret, r.Header.Get(SignatureHeader), body, time.Now()) {
		http.Error(w, "bad signature", http.StatusUnauthorized)
		return nil, false
	}
	return body, true
}

func answer(w http.ResponseWriter, v any, err error) {
	if err != nil {
		http.Error(w, "the bot failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// CommandHandler answers a bot's slash commands.
func CommandHandler(secret string, fn func(context.Context, Command) (CommandResponse, error)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := verified(w, r, secret)
		if !ok {
			return
		}
		var c Command
		if err := json.Unmarshal(body, &c); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		out, err := fn(r.Context(), c)
		answer(w, out, err)
	})
}

// InteractionHandler answers button presses, menu choices and dialog submissions.
func InteractionHandler(secret string, fn func(context.Context, Interaction) (InteractionResponse, error)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := verified(w, r, secret)
		if !ok {
			return
		}
		var in Interaction
		if err := json.Unmarshal(body, &in); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		out, err := fn(r.Context(), in)
		answer(w, out, err)
	})
}

// EventHandler receives an event subscription's deliveries; an error makes
// Cenacle try again later. A delivery can come twice: use Event.ID.
func EventHandler(secret string, fn func(context.Context, Event) error) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := verified(w, r, secret)
		if !ok {
			return
		}
		var ev Event
		if err := json.Unmarshal(body, &ev); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if err := fn(r.Context(), ev); err != nil {
			http.Error(w, "the bot failed", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}
