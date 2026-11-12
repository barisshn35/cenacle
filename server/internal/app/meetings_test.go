// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"io"
	"log/slog"
	"mime/quotedprintable"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Cenacle-TR/cenacle/server/internal/notify"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

type meetingOut struct {
	ID         string   `json:"id"`
	ChannelID  string   `json:"channel_id"`
	MyResponse string   `json:"my_response"`
	CanEdit    bool     `json:"can_edit"`
	Rrule      string   `json:"rrule"`
	Exdates    []string `json:"exdates"`
	Cancelled  bool     `json:"cancelled"`
	Invitees   []struct {
		UserID    string `json:"user_id"`
		Response  string `json:"response"`
		Organizer bool   `json:"organizer"`
	} `json:"invitees"`
}

func TestMeetings(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ctx := context.Background()
	ayse := s.user("meet-a", "Ayşe")
	mert := s.user("meet-m", "Mert")
	zeynep := s.user("meet-z", "Zeynep")
	s.general(ayse)
	// A private channel of Ayşe and Mert (Zeynep is not in it).
	var room struct {
		ID string `json:"id"`
	}
	admin := s.admin()
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "planning", "visibility": "private"}, &room)
	general := room.ID
	for _, u := range []string{ayse, mert} {
		s.call(http.MethodPost, "/api/channels/"+general+"/members", admin, map[string]any{"user_id": s.userID(u)}, nil)
	}
	if general == "" {
		t.Fatal("no channel")
	}
	if _, err := s.pool.Exec(ctx, "UPDATE workspaces SET calls_enabled = true WHERE id = $1", s.defaultWS); err != nil {
		t.Fatal(err)
	}
	ist, _ := time.LoadLocation("Europe/Istanbul")
	day := time.Now().In(ist).AddDate(0, 0, 2)
	start := time.Date(day.Year(), day.Month(), day.Day(), 14, 0, 0, 0, ist)
	input := func(rule string, users ...string) map[string]any {
		ids := []string{}
		for _, u := range users {
			ids = append(ids, s.userID(u))
		}
		return map[string]any{
			"workspace_id": s.defaultWS, "channel_id": general, "title": "Roadmap review", "agenda": "1. Results\n2. Plans",
			"starts_at": start, "ends_at": start.Add(45 * time.Minute), "timezone": "Europe/Istanbul", "rrule": rule, "user_ids": ids,
		}
	}

	// Rules that never end, and people outside the channel, are refused.
	if status, _ := problemCode(t, s, http.MethodPost, "/api/meetings", ayse, input("FREQ=WEEKLY", mert)); status != http.StatusBadRequest {
		t.Errorf("endless rule = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/meetings", ayse, input("", zeynep)); status != http.StatusBadRequest {
		t.Errorf("invitee outside the channel = %d", status)
	}

	var m meetingOut
	res := s.call(http.MethodPost, "/api/meetings", ayse, input("FREQ=WEEKLY;COUNT=4", mert), &m)
	if res.StatusCode != http.StatusCreated || m.MyResponse != "yes" || !m.CanEdit || len(m.Invitees) != 2 || !m.Invitees[0].Organizer {
		t.Fatalf("create = %d %+v", res.StatusCode, m)
	}
	// Zeynep is not invited: the meeting is not hers to see.
	if status, _ := problemCode(t, s, http.MethodGet, "/api/meetings/"+m.ID, zeynep, nil); status != http.StatusNotFound {
		t.Errorf("uninvited read = %d", status)
	}

	// Mert's calendar shows the occurrences in the range.
	var cal struct {
		Items []struct {
			Kind     string    `json:"kind"`
			ID       string    `json:"id"`
			StartsAt time.Time `json:"starts_at"`
			Response string    `json:"response"`
		} `json:"items"`
	}
	from := start.Add(-time.Hour).UTC().Format(time.RFC3339)
	to := start.AddDate(0, 0, 20).UTC().Format(time.RFC3339)
	s.call(http.MethodGet, "/api/calendar?from="+from+"&to="+to, mert, nil, &cal)
	if len(cal.Items) != 3 || cal.Items[1].StartsAt.In(ist).Hour() != 14 || cal.Items[0].Response != "pending" {
		t.Fatalf("calendar: %+v", cal.Items)
	}

	// Mert answers; he cannot change the meeting.
	if res := s.call(http.MethodPut, "/api/meetings/"+m.ID+"/response", mert, map[string]string{"response": "maybe"}, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("answer = %d", res.StatusCode)
	}
	s.call(http.MethodGet, "/api/meetings/"+m.ID, mert, nil, &m)
	if m.MyResponse != "maybe" || m.CanEdit {
		t.Errorf("after answering: %+v", m)
	}
	if status, _ := problemCode(t, s, http.MethodPut, "/api/meetings/"+m.ID, mert, map[string]any{}); status != http.StatusForbidden {
		t.Errorf("invitee changing = %d", status)
	}

	// Ayşe moves it an hour later: Mert gets a change e-mail with the old time.
	moved := input("FREQ=WEEKLY;COUNT=4", mert)
	delete(moved, "workspace_id")
	delete(moved, "channel_id")
	moved["starts_at"], moved["ends_at"] = start.Add(time.Hour), start.Add(105*time.Minute)
	s.call(http.MethodPut, "/api/meetings/"+m.ID, ayse, moved, &m)
	// One occurrence is cancelled.
	second := start.Add(time.Hour).AddDate(0, 0, 7)
	if status, _ := problemCode(t, s, http.MethodPost, "/api/meetings/"+m.ID+"/skip", ayse, map[string]any{"occurrence": second.Add(time.Minute)}); status != http.StatusBadRequest {
		t.Errorf("skip of no occurrence = %d", status)
	}
	s.call(http.MethodPost, "/api/meetings/"+m.ID+"/skip", ayse, map[string]any{"occurrence": second}, &m)
	if len(m.Exdates) != 1 {
		t.Fatalf("skipped: %+v", m)
	}
	s.call(http.MethodGet, "/api/calendar?from="+from+"&to="+to, mert, nil, &cal)
	if len(cal.Items) != 2 {
		t.Errorf("calendar after skip: %+v", cal.Items)
	}

	// The meeting as a file.
	_, header, body := s.get(mert, "/api/meetings/"+m.ID+"/ics")
	if header.Get("Content-Type") != "text/calendar; charset=utf-8" || !strings.Contains(string(body), "SUMMARY:Roadmap review") ||
		!strings.Contains(string(body), "DTSTART;TZID=Europe/Istanbul:") || !strings.Contains(string(body), "EXDATE;TZID=Europe/Istanbul:") {
		t.Errorf("ics: %s", body)
	}

	// A private subscription address: no sign-in, no agenda; replaced, the old one stops.
	var feed struct {
		URL string `json:"url"`
	}
	s.call(http.MethodPost, "/api/me/calendar-feed", mert, nil, &feed)
	path := feed.URL[strings.Index(feed.URL, "/api/"):]
	status, _, body := s.get("", path)
	if status != http.StatusOK || !strings.Contains(string(body), "SUMMARY:Roadmap review") || strings.Contains(string(body), "Results") {
		t.Errorf("feed = %d %s", status, body)
	}
	s.call(http.MethodPost, "/api/me/calendar-feed", mert, nil, nil)
	if status, _, _ := s.get("", path); status != http.StatusNotFound {
		t.Errorf("replaced feed = %d", status)
	}

	// A meeting without a channel opens the conversation with the invitees.
	conv := input("", zeynep)
	delete(conv, "channel_id")
	var dm meetingOut
	if res := s.call(http.MethodPost, "/api/meetings", ayse, conv, &dm); res.StatusCode != http.StatusCreated || dm.ChannelID == general {
		t.Fatalf("conversation meeting = %d %+v", res.StatusCode, dm)
	}

	// E-mails: Mert's invitation, not sent yet, comes as the meeting is now
	// (the later changes fold into it); Zeynep's is in Turkish, her language.
	s.call(http.MethodPut, "/api/me/language", zeynep, map[string]string{"language": "tr"}, nil)
	smtpd := newFakeSMTP(t)
	_, port, _ := net.SplitHostPort(smtpd.ln.Addr().String())
	job := &notify.Meetings{
		Queries: store.New(s.pool), Presence: fakePresence{}, PublicURL: "http://chat.test",
		Log:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		SMTP: &notify.SMTP{Host: "127.0.0.1", Port: atoi(t, port), From: "Cenacle <chat@example.com>", Security: "none"},
	}
	if n, err := job.Run(ctx); err != nil || n != 2 {
		t.Fatalf("mails = %d, %v", n, err)
	}
	if n, _ := job.Run(ctx); n != 0 {
		t.Errorf("sent again: %d", n)
	}
	smtpd.mu.Lock()
	mails := strings.Join(smtpd.mail, "\n=====\n")
	smtpd.mu.Unlock()
	for _, want := range []string{"method=REQUEST", "Content-Type: application/ics", "cid:logo", "Content-ID: <logo>",
		"multipart/alternative", "Zeynep"} {
		if !strings.Contains(mails, want) {
			t.Errorf("mails lack %q", want)
		}
	}
	// Subjects are encoded; the Turkish invitation and the English change.
	if !strings.Contains(mails, "=?utf-8?q?Davet:_Roadmap_review") || !strings.Contains(mails, "Subject: Invitation: Roadmap review") {
		for _, l := range strings.Split(mails, "\n") {
			if strings.HasPrefix(l, "Subject:") {
				t.Errorf("subject: %s", l)
			}
		}
	}

	// Once invited, a new time comes as a change with the old time.
	moved["starts_at"], moved["ends_at"] = start.Add(2*time.Hour), start.Add(165*time.Minute)
	s.call(http.MethodPut, "/api/meetings/"+m.ID, ayse, moved, &m)
	if n, err := job.Run(ctx); err != nil || n != 1 {
		t.Fatalf("change mail = %d, %v", n, err)
	}
	smtpd.mu.Lock()
	change := smtpd.mail[len(smtpd.mail)-1]
	smtpd.mu.Unlock()
	if plain, err := io.ReadAll(quotedprintable.NewReader(strings.NewReader(change))); err == nil {
		change = string(plain)
	}
	if !strings.Contains(change, "Subject: Changed: Roadmap review, now") || !strings.Contains(change, "was 15:00 – 15:45") {
		t.Errorf("change mail:\n%s", change[:min(len(change), 3000)])
	}

	// Cancelling tells Mert (by e-mail too).
	if res := s.call(http.MethodDelete, "/api/meetings/"+m.ID, ayse, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("cancel = %d", res.StatusCode)
	}
	if n, err := job.Run(ctx); err != nil || n != 1 {
		t.Fatalf("cancel mail = %d, %v", n, err)
	}
	smtpd.mu.Lock()
	last := smtpd.mail[len(smtpd.mail)-1]
	smtpd.mu.Unlock()
	if !strings.Contains(last, "method=CANCEL") || !strings.Contains(last, "Cancelled: Roadmap review") {
		t.Errorf("cancel mail:\n%s", last[:min(len(last), 1500)])
	}
	s.call(http.MethodGet, "/api/calendar?from="+from+"&to="+to, mert, nil, &cal)
	if len(cal.Items) != 0 {
		t.Errorf("cancelled meeting still listed: %+v", cal.Items)
	}
}

func TestMeetingReminders(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ctx := context.Background()
	ayse := s.user("rem-a", "Ayşe")
	mert := s.user("rem-m", "Mert")
	general := s.general(ayse)
	s.general(mert)
	if _, err := s.pool.Exec(ctx, "UPDATE workspaces SET calls_enabled = true WHERE id = $1", s.defaultWS); err != nil {
		t.Fatal(err)
	}
	start := time.Now().Add(8 * time.Minute).Truncate(time.Minute)
	var m meetingOut
	s.call(http.MethodPost, "/api/meetings", ayse, map[string]any{
		"workspace_id": s.defaultWS, "channel_id": general, "title": "Stand-up",
		"starts_at": start, "ends_at": start.Add(15 * time.Minute), "timezone": "UTC", "user_ids": []string{s.userID(mert)},
	}, &m)
	// Mert wants 5 minutes' notice: not yet; Ayşe (10 minutes, the default) now.
	var set struct {
		Prefs map[string]any `json:"prefs"`
	}
	s.call(http.MethodGet, "/api/me/notifications", mert, nil, &set)
	set.Prefs["meetings"] = map[string]any{"remind_minutes": 5, "email": true}
	if res := s.call(http.MethodPut, "/api/me/notifications", mert, set.Prefs, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("prefs = %d", res.StatusCode)
	}
	now := time.Now()
	job := &notify.Meetings{Queries: store.New(s.pool), Presence: fakePresence{}, PublicURL: "http://chat.test",
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: func() time.Time { return now }}
	if n, err := job.Run(ctx); err != nil || n != 1 {
		t.Fatalf("reminders = %d, %v", n, err)
	}
	if n, _ := job.Run(ctx); n != 0 {
		t.Errorf("reminded twice: %d", n)
	}
	now = now.Add(4 * time.Minute)
	if n, _ := job.Run(ctx); n != 1 {
		t.Errorf("Mert's reminder = %d", n)
	}
	var count int
	if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM meeting_reminders WHERE meeting_id = $1", m.ID).Scan(&count); err != nil || count != 2 {
		t.Errorf("reminders noted = %d, %v", count, err)
	}
}
