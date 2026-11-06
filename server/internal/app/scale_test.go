// SPDX-License-Identifier: AGPL-3.0-only

//go:build load

package app_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"testing"
	"time"
)

// TestScale fills a workspace with many messages (written to the database
// directly, as years of use would) and times what people open most: the
// channel list, unreads, activity, threads, history (newest and far back) and
// search (messages and the text of files). Settings: SCALE_MESSAGES (default
// 2,000,000), SCALE_CHANNELS (200), SCALE_PEOPLE (50), SCALE_ROUNDS (20 timings of
// each), LOAD_REPORT. Searches for one rare word, or for a word in nothing, fail the
// test when their median passes scaleSearchLimit.
// scaleSearchLimit bounds the median of the single-word searches. They take about
// 10 ms on 2,000,000 messages and 200,000 files; reading every message or file
// instead took 7–40 s. A limit a hundred times above the first and well below the
// second does not fail on a busy machine and still catches the slow plan.
const scaleSearchLimit = time.Second

func TestScale(t *testing.T) {
	total := envInt("SCALE_MESSAGES", 2_000_000)
	nChannels := envInt("SCALE_CHANNELS", 200)
	nPeople := envInt("SCALE_PEOPLE", 50)
	rounds := envInt("SCALE_ROUNDS", 20)
	s := newStack(t, newShared(t), options{perWindow: 1 << 30})
	ctx := context.Background()
	admin := s.admin()
	reader := s.user("sub-scale-reader", "Reader")
	people := []string{s.userID(admin), s.userID(reader)}
	for i := range nPeople {
		people = append(people, s.userID(s.user(fmt.Sprintf("sub-scale-%d", i), fmt.Sprintf("Person %d", i))))
	}
	channels := []string{s.general(admin)}
	for i := 1; i < nChannels; i++ {
		var c channel
		if res := s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": fmt.Sprintf("team-%03d", i)}, &c); res.StatusCode != http.StatusCreated {
			t.Fatalf("channel = %d", res.StatusCode)
		}
		channels = append(channels, c.ID)
	}

	start := time.Now()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := s.pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql[:min(len(sql), 60)], err)
		}
	}
	exec(`INSERT INTO channel_members (channel_id, user_id)
		SELECT c, p FROM unnest($1::uuid[]) c, unnest($2::uuid[]) p ON CONFLICT DO NOTHING`, channels, people)
	// Words of a working conversation, so that search has common and rare terms.
	exec(`INSERT INTO messages (channel_id, author_id, body, nonce)
		SELECT ($1::uuid[])[1 + g % cardinality($1::uuid[])], ($2::uuid[])[1 + (g / 7) % cardinality($2::uuid[])],
		       (ARRAY['deploy','review','meeting','invoice','release','incident','design','budget'])[1 + g % 8]
		         || ' notes for sprint ' || (g % 500) || ' item ' || g,
		       'scale-nonce-' || g
		FROM generate_series(1, $3::int) g`, channels, people, total)
	// One message in two hundred mentions the reader; the reader has read about half.
	exec(`INSERT INTO message_mentions (message_id, user_id, channel_id)
		SELECT id, $1::uuid, channel_id FROM messages WHERE nonce LIKE 'scale-nonce-%' AND hashtext(nonce) % 200 = 0`, s.userID(reader))
	exec(`UPDATE channel_members m SET last_read_id = (
		SELECT id FROM messages x WHERE x.channel_id = m.channel_id ORDER BY id DESC OFFSET 200 LIMIT 1)
		WHERE m.user_id = $1`, s.userID(reader))
	// One file in every ten messages, with a name and 80 words of read text.
	exec(`INSERT INTO files (workspace_id, channel_id, uploader_id, message_id, attached_at, name, content_type,
		                   size, status, content_text, content_state)
		SELECT $1::uuid, m.channel_id, m.author_id, m.id, m.created_at,
		       (ARRAY['Report','Invoice','Notes','Slides','Contract','Photo','Budget','Plan'])[1 + m.n % 8] || ' ' || (m.n % 997) || '.pdf',
		       'application/pdf', 1000, 'ready',
		       (SELECT string_agg((ARRAY['deploy','review','meeting','invoice','release','incident','design','budget'])[1 + (m.n * k) % 8]
		                          || ' ' || ((m.n * k) % 9973), ' ') FROM generate_series(1, 40) k),
		       'done'
		FROM (SELECT id, channel_id, author_id, created_at, row_number() OVER (ORDER BY id) AS n
		      FROM messages WHERE nonce LIKE 'scale-nonce-%') m
		WHERE m.n % 10 = 0`, s.defaultWS)
	exec(`UPDATE messages SET has_files = true WHERE id IN (SELECT message_id FROM files)`)
	// A rare word, in ten messages and ten files spread over the history.
	exec(`UPDATE messages SET body = body || ' zumrut'
		WHERE nonce IN (SELECT 'scale-nonce-' || (g * ($1::int / 10)) FROM generate_series(1, 10) g)`, total)
	exec(`UPDATE files SET content_text = content_text || ' yakut'
		WHERE id IN (SELECT id FROM (SELECT id, row_number() OVER (ORDER BY id) AS n, count(*) OVER () AS c FROM files) x
		             WHERE x.n % (x.c / 10) = 0)`)
	exec(`VACUUM ANALYZE messages`)
	exec(`VACUUM ANALYZE files`)
	exec(`ANALYZE`)
	seeded := time.Since(start)

	var deep string
	if err := s.pool.QueryRow(ctx, `SELECT id::text FROM messages WHERE channel_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 1`,
		channels[1], total/nChannels/2).Scan(&deep); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{}
	timings := map[string]*latencies{}
	get := func(name, path string) {
		req, _ := http.NewRequest(http.MethodGet, s.srv.URL+path, nil)
		req.Header.Set("Authorization", "Bearer "+reader)
		begin := time.Now()
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var out any
		_ = json.NewDecoder(res.Body).Decode(&out)
		_ = res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("%s = %d", path, res.StatusCode)
		}
		if timings[name] == nil {
			timings[name] = &latencies{}
		}
		timings[name].add(time.Since(begin))
	}
	for i := range rounds {
		ch := channels[1+i%(len(channels)-1)]
		get("channel list", "/api/channels")
		get("unreads", "/api/me/unreads?workspace_id="+s.defaultWS)
		get("activity", "/api/me/activity?workspace_id="+s.defaultWS)
		get("threads", "/api/me/threads?workspace_id="+s.defaultWS)
		get("history, newest", "/api/channels/"+ch+"/messages")
		get("history, far back", "/api/channels/"+channels[1]+"/messages?before="+url.QueryEscape(deep))
		get("search, common word", "/api/search/messages?q=review")
		get("search, rare term", "/api/search/messages?q="+url.QueryEscape(fmt.Sprintf("item %d", total-i*7)))
		get("search, rare word", "/api/search/messages?q=zumrut")
		get("search, word in nothing", "/api/search/messages?q=qxzvk")
		get("files, rare word", "/api/search/files?q=yakut")
		get("files, word in nothing", "/api/search/files?q=qxzvk")
	}
	for _, name := range []string{"search, rare word", "search, word in nothing", "files, rare word", "files, word in nothing"} {
		if p50 := time.Duration(timings[name].summary()["p50_ms"] * float64(time.Millisecond)); p50 > scaleSearchLimit {
			t.Errorf("%s: median %v, over %v", name, p50, scaleSearchLimit)
		}
	}
	report := map[string]any{"messages": total, "channels": nChannels, "people": len(people), "seed_seconds": seeded.Seconds()}
	for name, l := range timings {
		report[name] = l.summary()
	}
	raw, _ := json.MarshalIndent(report, "", "  ")
	t.Logf("scale report:\n%s", raw)
	if f := os.Getenv("LOAD_REPORT"); f != "" {
		if err := os.WriteFile(f, raw, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}
