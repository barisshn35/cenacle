// SPDX-License-Identifier: AGPL-3.0-only

package telemetry

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
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

// Traced requests record the path as the access log does: tokens in paths
// never reach a span.
func TestTraceHandlerRedactsPathTokens(t *testing.T) {
	spans := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(spans))
	r := chi.NewRouter()
	r.Use(Middleware)
	r.Post("/api/hooks/{token}", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	r.Post("/api/invites/{token}/accept", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	r.Get("/api/channels", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	srv := httptest.NewServer(TraceHandler(r, otelhttp.WithTracerProvider(tp)))
	defer srv.Close()
	for _, p := range []string{"/api/hooks/cnh_secret-hook", "/api/invites/secret-invite/accept"} {
		res, err := http.Post(srv.URL+p, "application/json", nil)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
	}
	res, err := http.Get(srv.URL + "/api/channels")
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()

	paths := map[string]bool{}
	for _, s := range spans.Ended() {
		for _, a := range s.Attributes() {
			if strings.Contains(a.Value.String(), "secret") {
				t.Errorf("span %q records %s=%s", s.Name(), a.Key, a.Value.String())
			}
			if a.Key == "url.path" {
				paths[a.Value.AsString()] = true
			}
		}
	}
	for _, want := range []string{"/api/hooks/[redacted]", "/api/invites/[redacted]/accept", "/api/channels"} {
		if !paths[want] {
			t.Errorf("url.path %q not recorded (got %v)", want, paths)
		}
	}
}
