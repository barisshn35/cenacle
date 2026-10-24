// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/egress"
	"github.com/barisshn35/cenacle/server/internal/integrations"
	"github.com/barisshn35/cenacle/server/internal/integrations/feeds"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// Limits of feeds.
const (
	MaxChannelFeeds = 20
	// MaxFeedPosts is how many new items one reading posts (the newest).
	MaxFeedPosts = 5
	maxSeen      = 200
)

// fetchFeed reads a feed; with an ETag or Last-Modified from before it may
// come back unchanged (nil feed).
func fetchFeed(ctx context.Context, client *egress.Client, address, etag, lastModified string) (*feeds.Feed, string, string, error) {
	if client == nil {
		return nil, "", "", errors.New("no egress client")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, "", "", err
	}
	req.Header.Set("User-Agent", "Cenacle")
	req.Header.Set("Accept", "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5")
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	if lastModified != "" {
		req.Header.Set("If-Modified-Since", lastModified)
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, "", "", err
	}
	if res.Status == http.StatusNotModified {
		return nil, etag, lastModified, nil
	}
	if res.Status < 200 || res.Status > 299 {
		return nil, "", "", fmt.Errorf("status %d", res.Status)
	}
	f, err := feeds.Parse(res.Body)
	if err != nil {
		return nil, "", "", err
	}
	return &f, res.Header.Get("ETag"), res.Header.Get("Last-Modified"), nil
}

// FeedReader reads the feeds channels follow and posts their new items.
type FeedReader struct {
	DB      TxBeginner
	Queries *store.Queries
	Egress  *egress.Client
	Log     *slog.Logger
}

// Run reads the feeds that are due; it returns how many items it posted.
func (fr *FeedReader) Run(ctx context.Context) (int, error) {
	due, err := fr.Queries.DueFeeds(ctx)
	if err != nil {
		return 0, err
	}
	posted := 0
	for _, f := range due {
		n, err := fr.read(ctx, f)
		if err != nil {
			fr.Log.InfoContext(ctx, "feed", "url", f.Url, "error", err)
			if err := fr.Queries.FeedFailed(ctx, store.FeedFailedParams{ID: f.ID, LastError: integrations.Truncate(err.Error(), 300)}); err != nil {
				return posted, err
			}
			continue
		}
		posted += n
	}
	return posted, nil
}

func (fr *FeedReader) read(ctx context.Context, f store.DueFeedsRow) (int, error) {
	if f.Encrypted {
		return 0, errors.New("the channel is encrypted end to end")
	}
	feed, etag, modified, err := fetchFeed(ctx, fr.Egress, f.Url, f.Etag, f.LastModified)
	if err != nil {
		return 0, err
	}
	if feed == nil { // not modified
		return 0, fr.Queries.FeedChecked(ctx, store.FeedCheckedParams{
			ID: f.ID, Seen: f.Seen, Title: f.Title, Etag: etag, LastModified: modified,
		})
	}
	seen := map[string]bool{}
	for _, id := range f.Seen {
		seen[id] = true
	}
	// Feeds list the newest first: post the new ones oldest first, the
	// newest few only.
	var fresh []feeds.Item
	for _, it := range feed.Items {
		if !seen[it.ID] {
			fresh = append(fresh, it)
		}
	}
	if len(fresh) > MaxFeedPosts {
		fresh = fresh[:MaxFeedPosts]
	}
	title := feed.Title
	if title == "" {
		title = hostOf(f.Url)
	}
	err = inTx(ctx, fr.DB, func(q *store.Queries) error {
		if len(fresh) > 0 {
			bot, err := systemBot(ctx, q, f.WorkspaceID)
			if err != nil {
				return err
			}
			c, err := q.GetChannel(ctx, f.ChannelID)
			if err != nil {
				return err
			}
			for i := len(fresh) - 1; i >= 0; i-- {
				it := fresh[i]
				card := integrations.Card(it.Title, it.Link, integrations.Truncate(it.Summary, 500), "neutral",
					integrations.Truncate(title, 150), nil)
				raw, _ := json.Marshal([]api.Attachment{card})
				if _, err := postMessage(ctx, q, c, bot, "", "feed-"+randomNonce(), raw); err != nil {
					return err
				}
			}
		}
		next := f.Seen
		for i := len(feed.Items) - 1; i >= 0; i-- {
			if id := feed.Items[i].ID; !seen[id] {
				next = append(next, id)
				seen[id] = true
			}
		}
		if len(next) > maxSeen {
			next = next[len(next)-maxSeen:]
		}
		return q.FeedChecked(ctx, store.FeedCheckedParams{ID: f.ID, Seen: next, Title: integrations.Truncate(title, 200), Etag: etag, LastModified: modified})
	})
	return len(fresh), err
}

func hostOf(address string) string {
	if u, err := url.Parse(address); err == nil && u.Host != "" {
		return u.Host
	}
	return address
}

// commandFeed is /feed: subscribe <url>, unsubscribe <url> or list (channel managers).
func (h *Handlers) commandFeed(w http.ResponseWriter, r *http.Request, user store.User, c store.Channel, role access, text string) {
	verb, arg, _ := strings.Cut(strings.TrimSpace(text), " ")
	arg = strings.TrimSpace(arg)
	ctx := r.Context()
	switch strings.ToLower(verb) {
	case "", "list":
		list, err := h.Queries.ListChannelFeeds(ctx, c.ID)
		if err != nil {
			h.unavailable(w, r, "list feeds", err)
			return
		}
		if len(list) == 0 {
			ephemeral(w, "This channel follows no feeds. `/feed subscribe <address>` adds one.")
			return
		}
		lines := []string{"This channel follows:"}
		for _, f := range list {
			line := "- " + f.Url
			if f.Title != "" {
				line = "- " + f.Title + " — " + f.Url
			}
			if f.LastError != "" {
				line += " (last reading failed: " + f.LastError + ")"
			}
			lines = append(lines, line)
		}
		ephemeral(w, strings.Join(lines, "\n"))
		return
	case "subscribe", "unsubscribe":
	default:
		ephemeral(w, "Use `/feed subscribe <address>`, `/feed unsubscribe <address>` or `/feed list`.")
		return
	}
	if !canManage(c, role) {
		ephemeral(w, "Only the channel's managers can change its feeds.")
		return
	}
	if c.Encrypted || isConversation(c) {
		ephemeral(w, "Feeds are for channels that are not encrypted.")
		return
	}
	if strings.EqualFold(verb, "unsubscribe") {
		n, err := h.Queries.DeleteFeed(ctx, store.DeleteFeedParams{ChannelID: c.ID, Url: arg})
		if err != nil {
			h.unavailable(w, r, "delete feed", err)
			return
		}
		if n == 0 {
			ephemeral(w, "This channel does not follow "+arg+".")
			return
		}
		ephemeral(w, "No longer following "+arg+".")
		return
	}
	if problem := h.checkTarget(arg); problem != "" {
		ephemeral(w, problem)
		return
	}
	if n, err := h.Queries.CountChannelFeeds(ctx, c.ID); err != nil {
		h.unavailable(w, r, "count feeds", err)
		return
	} else if n >= MaxChannelFeeds {
		ephemeral(w, "A channel follows up to 20 feeds.")
		return
	}
	feed, etag, modified, err := fetchFeed(ctx, h.Egress, arg, "", "")
	if err != nil || feed == nil {
		ephemeral(w, "Could not read a feed at "+arg+".")
		return
	}
	// What the feed has now is known; only items that come later are posted.
	seen := []string{}
	for i := len(feed.Items) - 1; i >= 0; i-- {
		seen = append(seen, feed.Items[i].ID)
	}
	if len(seen) > maxSeen {
		seen = seen[len(seen)-maxSeen:]
	}
	title := feed.Title
	if title == "" {
		title = hostOf(arg)
	}
	created, err := h.Queries.CreateFeed(ctx, store.CreateFeedParams{
		ChannelID: c.ID, Url: arg, Title: integrations.Truncate(title, 200), Seen: seen, CreatedBy: user.ID,
	})
	if isUniqueViolation(err) {
		ephemeral(w, "This channel follows "+arg+" already.")
		return
	}
	if err != nil {
		h.unavailable(w, r, "create feed", err)
		return
	}
	_ = h.Queries.FeedChecked(ctx, store.FeedCheckedParams{ID: created.ID, Seen: seen, Title: created.Title, Etag: etag, LastModified: modified})
	ephemeral(w, "Following "+created.Title+". New items will be posted here.")
}
