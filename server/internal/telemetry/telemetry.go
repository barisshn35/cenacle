// SPDX-License-Identifier: AGPL-3.0-only

// Package telemetry exposes Prometheus metrics and, when an OTLP endpoint is
// configured with the standard OTEL_* variables, sends traces with
// OpenTelemetry. Nothing leaves the installation unless the operator points it
// somewhere: there is no telemetry to the project.
package telemetry

import (
	"cmp"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"

	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
)

// Registry holds Cenacle's metrics (and Go runtime and process metrics).
var Registry = prometheus.NewRegistry()

// Metrics of the application.
var (
	httpDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "cenacle_http_request_duration_seconds",
		Help:    "Duration of HTTP requests by route.",
		Buckets: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
	}, []string{"method", "route", "code"})
	WSConnections = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "cenacle_websocket_connections",
		Help: "Open WebSocket connections on this instance.",
	})
	Messages = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "cenacle_messages_sent_total",
		Help: "Messages stored (people, bots, webhooks, scheduled).",
	})
	Uploads = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "cenacle_file_uploads_total",
		Help: "Completed uploads by result (ready, blocked).",
	}, []string{"result"})
	UploadBytes = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "cenacle_file_upload_bytes_total",
		Help: "Bytes of completed uploads.",
	})
	Deliveries = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "cenacle_event_deliveries_total",
		Help: "Attempts to deliver events to bots by result (succeeded, retry, failed).",
	}, []string{"result"})
)

func init() {
	Registry.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		httpDuration, WSConnections, Messages, Uploads, UploadBytes, Deliveries,
	)
}

// RegisterPool adds the database pool's statistics.
func RegisterPool(pool *pgxpool.Pool) {
	Registry.MustRegister(poolCollector{pool})
}

var (
	poolAcquired = prometheus.NewDesc("cenacle_db_pool_acquired_connections", "Connections in use.", nil, nil)
	poolIdle     = prometheus.NewDesc("cenacle_db_pool_idle_connections", "Idle connections.", nil, nil)
	poolMax      = prometheus.NewDesc("cenacle_db_pool_max_connections", "Largest pool size.", nil, nil)
	poolWaits    = prometheus.NewDesc("cenacle_db_pool_empty_acquire_total", "Acquires that had to wait.", nil, nil)
)

type poolCollector struct{ pool *pgxpool.Pool }

func (poolCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- poolAcquired
	ch <- poolIdle
	ch <- poolMax
	ch <- poolWaits
}

func (c poolCollector) Collect(ch chan<- prometheus.Metric) {
	s := c.pool.Stat()
	ch <- prometheus.MustNewConstMetric(poolAcquired, prometheus.GaugeValue, float64(s.AcquiredConns()))
	ch <- prometheus.MustNewConstMetric(poolIdle, prometheus.GaugeValue, float64(s.IdleConns()))
	ch <- prometheus.MustNewConstMetric(poolMax, prometheus.GaugeValue, float64(s.MaxConns()))
	ch <- prometheus.MustNewConstMetric(poolWaits, prometheus.CounterValue, float64(s.EmptyAcquireCount()))
}

// Handler serves the metrics in the Prometheus format.
func Handler() http.Handler {
	return promhttp.HandlerFor(Registry, promhttp.HandlerOpts{Registry: Registry})
}

// Middleware records the duration of requests by route pattern (never by
// raw path, which would carry ids) and names the request's span after it.
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		// chi's wrapper keeps http.Hijacker for WebSockets.
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		route := "unmatched"
		if rc := chi.RouteContext(r.Context()); rc != nil && rc.RoutePattern() != "" {
			route = rc.RoutePattern()
		}
		if route == "/api/hooks/{token}" {
			route = "/api/hooks/*" // the pattern is safe; keep the label short
		}
		trace.SpanFromContext(r.Context()).SetName(r.Method + " " + route)
		httpDuration.WithLabelValues(r.Method, route, strconv.Itoa(cmp.Or(ww.Status(), http.StatusOK))).Observe(time.Since(start).Seconds())
	})
}

// TraceHandler traces every request handled by next. The span's url.path is
// the path as the access log records it: tokens carried in paths (webhook,
// invite and guest-link addresses) never leave the process.
func TraceHandler(next http.Handler, opts ...otelhttp.Option) http.Handler {
	redacted := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		trace.SpanFromContext(r.Context()).SetAttributes(semconv.URLPath(httpx.RedactPath(r.URL.Path)))
		next.ServeHTTP(w, r)
	})
	return otelhttp.NewHandler(redacted, "http", opts...)
}

// TracingEnabled says whether an OTLP endpoint is configured.
func TracingEnabled() bool {
	return os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "" || os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") != ""
}

// SetupTracing starts sending traces when an OTLP endpoint is configured; the
// returned function flushes and stops it. Sampling follows OTEL_TRACES_SAMPLER.
func SetupTracing(ctx context.Context, service, version string, log *slog.Logger) (func(context.Context) error, error) {
	if !TracingEnabled() {
		return func(context.Context) error { return nil }, nil
	}
	exporter, err := otlptracehttp.New(ctx)
	if err != nil {
		return nil, err
	}
	res, err := resource.Merge(resource.Default(), resource.NewWithAttributes(semconv.SchemaURL,
		semconv.ServiceName(service), semconv.ServiceVersion(version)))
	if err != nil && !errors.Is(err, resource.ErrSchemaURLConflict) {
		return nil, err
	}
	tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exporter), sdktrace.WithResource(res))
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))
	log.Info("tracing enabled")
	return tp.Shutdown, nil
}

// LogHandler adds the trace and span ids of the context to log records.
type LogHandler struct{ slog.Handler }

// Handle implements slog.Handler.
func (h LogHandler) Handle(ctx context.Context, r slog.Record) error {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		r.AddAttrs(slog.String("trace_id", sc.TraceID().String()), slog.String("span_id", sc.SpanID().String()))
	}
	return h.Handler.Handle(ctx, r)
}

// WithAttrs implements slog.Handler.
func (h LogHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return LogHandler{h.Handler.WithAttrs(attrs)}
}

// WithGroup implements slog.Handler.
func (h LogHandler) WithGroup(name string) slog.Handler { return LogHandler{h.Handler.WithGroup(name)} }
