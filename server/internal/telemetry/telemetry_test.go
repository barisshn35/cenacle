// SPDX-License-Identifier: AGPL-3.0-only

package telemetry

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestMiddlewareRecordsRoutes(t *testing.T) {
	r := chi.NewRouter()
	r.Use(Middleware)
	r.Get("/api/channels/{channel_id}/messages", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})
	srv := httptest.NewServer(r)
	defer srv.Close()
	res, err := http.Get(srv.URL + "/api/channels/0193-secret-id/messages")
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	Messages.Inc()

	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	body, _ := io.ReadAll(rec.Body)
	out := string(body)
	for _, want := range []string{
		`cenacle_http_request_duration_seconds_count{code="418",method="GET",route="/api/channels/{channel_id}/messages"} 1`,
		"cenacle_messages_sent_total 1",
		"go_goroutines",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("metrics lack %q", want)
		}
	}
	if strings.Contains(out, "secret-id") {
		t.Error("metrics carry a raw path")
	}
}
