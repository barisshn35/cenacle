// SPDX-License-Identifier: AGPL-3.0-only

// Command media runs the isolated Cenacle call service.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/google/uuid"

	"github.com/Cenacle-TR/cenacle/server/internal/cache"
	"github.com/Cenacle-TR/cenacle/server/internal/config"
	"github.com/Cenacle-TR/cenacle/server/internal/health"
	"github.com/Cenacle-TR/cenacle/server/internal/logging"
	"github.com/Cenacle-TR/cenacle/server/internal/media"
)

var version = "dev"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "media:", err)
		os.Exit(1)
	}
}
func run(args []string) error {
	if len(args) == 1 && args[0] == "version" {
		fmt.Println(version)
		return nil
	}
	if len(args) == 1 && args[0] == "healthcheck" {
		address := os.Getenv("CENACLE_MEDIA_HTTP_ADDR")
		if address == "" {
			address = ":7880"
		}
		_, port, err := net.SplitHostPort(address)
		if err != nil {
			return errors.New("invalid media HTTP address")
		}
		client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil}}
		request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, "http://127.0.0.1:"+port+"/healthz", nil) //nolint:gosec // this process's own loopback port
		if err != nil {
			return errors.New("invalid media HTTP address")
		}
		response, err := client.Do(request) //nolint:gosec // this process's own loopback port
		if err != nil {
			return errors.New("media probe failed")
		}
		defer func() { _ = response.Body.Close() }()
		if response.StatusCode != http.StatusOK {
			return errors.New("media probe failed")
		}
		return nil
	}
	if len(args) != 1 || args[0] != "serve" {
		return errors.New("usage: media serve | healthcheck | version")
	}
	cfg, err := config.LoadMedia(os.LookupEnv, os.ReadFile)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	log := logging.New(os.Stdout, "json", slog.LevelInfo).With("service", "cenacle-media", "build", version)
	client := cache.New(cfg.ValkeyAddr, cfg.ValkeyPassword)
	defer client.Close()
	lease := &media.Lease{Cache: client, NodeID: cfg.NodeID, Generation: uuid.NewString()}
	signals := &media.SignalHandler{Origin: cfg.Origin, Tokens: &media.Tokens{Public: cfg.AdmissionPublic, KeyID: cfg.AdmissionKeyID, Issuer: cfg.Origin, Store: client}, Lease: lease, Log: log}
	var turnConfig *media.TURNConfig
	if cfg.TURN != nil {
		turnConfig = &media.TURNConfig{Secret: cfg.TURN.Secret, Certificate: cfg.TURN.Certificate, PrivateKey: cfg.TURN.PrivateKey, MinPort: cfg.TURN.MinPort, MaxPort: cfg.TURN.MaxPort, MaxAllocations: cfg.TURN.MaxAllocations}
	}
	engine, err := media.NewSFU(media.SFUConfig{PublicIP: cfg.PublicIP, UDPAddr: cfg.ICEUDPAddr, TCPAddr: cfg.ICETCPAddr, Authority: &media.ControlClient{URL: cfg.ControlURL, Private: cfg.ControlPrivate}, TURN: turnConfig})
	if err != nil {
		return err
	}
	defer func() { _ = engine.Close() }()
	signals.Open = engine.Open
	probes := &health.Handler{Checkers: []health.Checker{client, lease, engine}, Timeout: 2 * time.Second, Log: log}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", probes.Healthz)
	mux.HandleFunc("GET /readyz", probes.Readyz)
	mux.Handle("/media/ws", signals)
	if lab := media.LabHandler(engine); lab != nil {
		mux.Handle("GET /lab/state", lab)
	}
	server := &http.Server{Addr: cfg.HTTPAddr, Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 8192, BaseContext: func(net.Listener) context.Context { return ctx }}
	results := make(chan error, 2)
	go func() { results <- lease.Run(ctx) }()
	go func() { results <- server.ListenAndServe() }()
	select {
	case <-ctx.Done():
	case err = <-results:
		cancel()
	}
	shutdown, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	_ = server.Shutdown(shutdown)
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
