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
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/barisshn35/cenacle/server/internal/realtime"
)

// TestSoak runs the server for a long time at a steady, ordinary pace: people
// send messages, connections come and go (reconnects, closed laptops), and
// the server's memory, goroutines and database connections are sampled. After
// warming up nothing may keep growing. Settings: LOAD_SECONDS (default 600),
// SOAK_RATE (messages per second, 20), LOAD_SOCKETS (200), SOAK_CHURN (share
// of connections replaced per minute, in percent, 20), LOAD_REPORT.
func TestSoak(t *testing.T) {
	seconds := envInt("LOAD_SECONDS", 600)
	rate := envInt("SOAK_RATE", 20)
	sockets := envInt("LOAD_SOCKETS", 200)
	churn := envInt("SOAK_CHURN", 20)
	s := newStack(t, newShared(t), options{perWindow: 1 << 30,
		settings: realtime.Settings{Heartbeat: 25 * time.Second, SessionCheck: time.Minute, QueueSize: 256, MaxBacklog: 500}})
	admin := s.admin()
	general := s.general(admin)
	tokens := make([]string, 50)
	for i := range tokens {
		tokens[i] = s.user(fmt.Sprintf("sub-soak-%d", i), fmt.Sprintf("Person %d", i))
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var delivered, errs atomic.Int64
	// A connection that reads until it is told to go.
	open := func(i int) context.CancelFunc {
		cctx, stop := context.WithCancel(ctx)
		c := s.connect(tokens[i%len(tokens)], "")
		go func() {
			defer func() { _ = c.CloseNow() }()
			for {
				if _, _, err := c.Read(cctx); err != nil {
					return
				}
				delivered.Add(1)
			}
		}()
		return stop
	}
	conns := make([]context.CancelFunc, sockets)
	for i := range conns {
		conns[i] = open(i)
	}

	// Steady sending.
	client := &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: 32}}
	var sent atomic.Int64
	var senders sync.WaitGroup
	senders.Go(func() {
		tick := time.NewTicker(time.Second / time.Duration(rate))
		defer tick.Stop()
		for n := 0; ; n++ {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
			}
			tok := tokens[n%len(tokens)]
			nonce := fmt.Sprintf("soak-message-%d", n)
			body, _ := json.Marshal(map[string]string{"body": "Soak message " + nonce, "nonce": nonce})
			req, _ := http.NewRequest(http.MethodPost, s.srv.URL+"/api/channels/"+general+"/messages", bytes.NewReader(body))
			req.Header.Set("Authorization", "Bearer "+tok)
			req.Header.Set("Content-Type", "application/json")
			res, err := client.Do(req)
			if err != nil {
				errs.Add(1)
				continue
			}
			out, _ := io.ReadAll(res.Body)
			_ = res.Body.Close()
			if res.StatusCode != http.StatusCreated {
				if errs.Add(1) <= 3 {
					t.Logf("send %d = %d: %s", n, res.StatusCode, out)
				}
				continue
			}
			sent.Add(1)
		}
	})

	type sample struct {
		Minute     float64 `json:"minute"`
		HeapMB     float64 `json:"heap_mb"`
		Goroutines int     `json:"goroutines"`
		DBConns    int32   `json:"db_conns"`
	}
	take := func(since time.Time) sample {
		runtime.GC()
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		return sample{Minute: time.Since(since).Minutes(), HeapMB: float64(m.HeapAlloc) / (1 << 20),
			Goroutines: runtime.NumGoroutine(), DBConns: s.pool.Stat().TotalConns()}
	}
	begin := time.Now()
	var samples []sample
	every := max(time.Duration(seconds)*time.Second/20, 10*time.Second)
	replace := max(sockets*churn/100, 1)
	next := 0
	deadline := begin.Add(time.Duration(seconds) * time.Second)
	sampleAt, churnAt := begin.Add(every), begin.Add(time.Minute)
	for time.Now().Before(deadline) {
		time.Sleep(time.Second)
		if now := time.Now(); now.After(churnAt) {
			for range replace {
				conns[next]()
				conns[next] = open(next)
				next = (next + 1) % sockets
			}
			churnAt = now.Add(time.Minute)
		}
		if now := time.Now(); now.After(sampleAt) {
			samples = append(samples, take(begin))
			sampleAt = now.Add(every)
		}
	}
	cancel()
	senders.Wait()

	report := map[string]any{"seconds": seconds, "rate": rate, "sockets": sockets, "churn_percent": churn,
		"sent": sent.Load(), "errors": errs.Load(), "frames_delivered": delivered.Load(), "samples": samples}
	raw, _ := json.MarshalIndent(report, "", "  ")
	t.Logf("soak report:\n%s", raw)
	if f := os.Getenv("LOAD_REPORT"); f != "" {
		if err := os.WriteFile(f, raw, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if errs.Load() > 0 {
		t.Errorf("%d requests failed", errs.Load())
	}
	// After the first quarter (warming up), growth means a leak.
	if len(samples) >= 4 {
		warm, last := samples[len(samples)/4], samples[len(samples)-1]
		if last.Goroutines > warm.Goroutines+warm.Goroutines/5+20 {
			t.Errorf("goroutines grew from %d to %d", warm.Goroutines, last.Goroutines)
		}
		if last.HeapMB > warm.HeapMB*1.5+16 {
			t.Errorf("heap grew from %.1f to %.1f MB", warm.HeapMB, last.HeapMB)
		}
	}
}
