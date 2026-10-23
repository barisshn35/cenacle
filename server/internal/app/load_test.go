// SPDX-License-Identifier: AGPL-3.0-only

//go:build load

package app_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"runtime/pprof"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/barisshn35/cenacle/server/internal/realtime"
)

// The load test runs the real server in this process (HTTP, PostgreSQL,
// Valkey, WebSockets) and measures what people feel: how long sending,
// receiving, scrolling back and searching take under many senders and
// readers. `make load` runs it; LOAD_USERS, LOAD_SOCKETS, LOAD_SECONDS and
// LOAD_PROFILE (a CPU profile file) change it; LOAD_REPORT writes the numbers
// as JSON.

type latencies struct {
	mu sync.Mutex
	d  []time.Duration
}

func (l *latencies) add(d time.Duration) {
	l.mu.Lock()
	l.d = append(l.d, d)
	l.mu.Unlock()
}

func (l *latencies) summary() map[string]float64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.d) == 0 {
		return map[string]float64{"count": 0}
	}
	slices.Sort(l.d)
	q := func(p float64) float64 {
		return float64(l.d[min(len(l.d)-1, int(p*float64(len(l.d))))].Microseconds()) / 1000
	}
	return map[string]float64{"count": float64(len(l.d)), "p50_ms": q(0.50), "p95_ms": q(0.95), "p99_ms": q(0.99), "max_ms": q(1)}
}

func envInt(name string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil && v > 0 {
		return v
	}
	return def
}

func TestLoad(t *testing.T) {
	users := envInt("LOAD_USERS", 100)
	sockets := envInt("LOAD_SOCKETS", 200)
	seconds := envInt("LOAD_SECONDS", 20)
	s := newStack(t, newShared(t), options{perWindow: 1 << 30,
		settings: realtime.Settings{Heartbeat: 30 * time.Second, SessionCheck: time.Minute, QueueSize: 256, MaxBacklog: 500}})
	admin := s.admin()
	general := s.general(admin)

	tokens := make([]string, users)
	for i := range tokens {
		tokens[i] = s.user(fmt.Sprintf("sub-load-%d", i), fmt.Sprintf("Person %d", i))
	}
	if f := os.Getenv("LOAD_PROFILE"); f != "" {
		out, err := os.Create(f)
		if err != nil {
			t.Fatal(err)
		}
		if err := pprof.StartCPUProfile(out); err != nil {
			t.Fatal(err)
		}
		defer pprof.StopCPUProfile()
	}

	// Readers: live connections, each timing when messages arrive.
	sent := sync.Map{} // nonce -> time sent
	delivery := &latencies{}
	var received atomic.Int64
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var readers sync.WaitGroup
	for i := range sockets {
		c := s.connect(tokens[i%users], "")
		readers.Go(func() {
			for {
				_, raw, err := c.Read(ctx)
				if err != nil {
					return
				}
				var f struct {
					Type string `json:"type"`
					Data struct {
						Nonce string `json:"nonce"`
					} `json:"data"`
				}
				if json.Unmarshal(raw, &f) == nil && f.Type == "message.created" {
					if at, ok := sent.Load(f.Data.Nonce); ok {
						delivery.add(time.Since(at.(time.Time)))
						received.Add(1)
					}
				}
			}
		})
	}

	// Senders: every person sends, one message after another, for the duration.
	send := &latencies{}
	var errs atomic.Int64
	deadline := time.Now().Add(time.Duration(seconds) * time.Second)
	var senders sync.WaitGroup
	client := &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: users}}
	for i, tok := range tokens {
		senders.Go(func() {
			for n := 0; time.Now().Before(deadline); n++ {
				nonce := fmt.Sprintf("load-%d-%d", i, n)
				body, _ := json.Marshal(map[string]string{"body": "Load message " + nonce, "nonce": nonce})
				req, _ := http.NewRequest(http.MethodPost, s.srv.URL+"/api/channels/"+general+"/messages", bytes.NewReader(body))
				req.Header.Set("Authorization", "Bearer "+tok)
				req.Header.Set("Content-Type", "application/json")
				start := time.Now()
				sent.Store(nonce, start)
				res, err := client.Do(req)
				if err != nil {
					errs.Add(1)
					continue
				}
				_, _ = io.Copy(io.Discard, res.Body)
				_ = res.Body.Close()
				if res.StatusCode != http.StatusCreated {
					errs.Add(1)
					continue
				}
				send.add(time.Since(start))
			}
		})
	}
	senders.Wait()
	time.Sleep(3 * time.Second) // the last events arrive
	cancel()
	readers.Wait()

	// Reading back: pages of history and searches, by many at once.
	history, search := &latencies{}, &latencies{}
	var readersWG sync.WaitGroup
	for i, tok := range tokens {
		readersWG.Go(func() {
			get := func(path string, l *latencies) map[string]any {
				req, _ := http.NewRequest(http.MethodGet, s.srv.URL+path, nil)
				req.Header.Set("Authorization", "Bearer "+tok)
				start := time.Now()
				res, err := client.Do(req)
				if err != nil {
					errs.Add(1)
					return nil
				}
				var out map[string]any
				_ = json.NewDecoder(res.Body).Decode(&out)
				_ = res.Body.Close()
				if res.StatusCode != http.StatusOK {
					errs.Add(1)
					return nil
				}
				l.add(time.Since(start))
				return out
			}
			before := ""
			for range 5 {
				page := get("/api/channels/"+general+"/messages"+before, history)
				msgs, _ := page["messages"].([]any)
				if len(msgs) == 0 {
					break
				}
				first, _ := msgs[0].(map[string]any)
				before = "?before=" + url.QueryEscape(fmt.Sprint(first["id"]))
			}
			get("/api/search/messages?q="+url.QueryEscape(fmt.Sprintf("load-%d", i)), search)
		})
	}
	readersWG.Wait()

	sends := send.summary()
	report := map[string]any{
		"users": users, "sockets": sockets, "seconds": seconds,
		"messages_per_second": sends["count"] / float64(seconds),
		"send":                sends, "delivery": delivery.summary(), "history_page": history.summary(), "search": search.summary(),
		"errors": errs.Load(), "deliveries": received.Load(),
	}
	raw, _ := json.MarshalIndent(report, "", "  ")
	t.Logf("load report:\n%s", raw)
	if f := os.Getenv("LOAD_REPORT"); f != "" {
		if err := os.WriteFile(f, raw, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if errs.Load() > 0 {
		t.Errorf("%d requests failed", errs.Load())
	}
}
