// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"golang.org/x/net/html"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/egress"
	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/preview"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// Link previews are fetched in the background, through the egress client
// (no private addresses, bounded time and size), and shared by every message
// that links the same address.
const (
	linkBatch     = 20
	linkRedirects = 3
	// linkFresh is how long a fetched preview (or a failed fetch) is reused.
	linkFresh = 24 * time.Hour
)

// LinkFetcher fetches the previews of new messages' links (a periodic job).
type LinkFetcher struct {
	DB      TxBeginner
	Queries *store.Queries
	// Egress must not carry the integrations' allow list: anyone can post a link.
	Egress *egress.Client
	Log    *slog.Logger
}

// Run implements jobs.Runner: it settles the pending links.
func (f *LinkFetcher) Run(ctx context.Context) (int, error) {
	rows, err := f.Queries.ListPendingLinks(ctx, linkBatch)
	if err != nil || len(rows) == 0 {
		return 0, err
	}
	previews := map[string]*api.LinkPreview{}
	for _, row := range rows {
		link := row.LinkUrl.String
		if _, done := previews[link]; !done {
			previews[link] = f.preview(ctx, link)
		}
		err := inTx(ctx, f.DB, func(q *store.Queries) error {
			if err := q.SetLinkState(ctx, store.SetLinkStateParams{ID: row.ID, LinkState: pgtype.Text{String: "done", Valid: true}}); err != nil {
				return err
			}
			return emit(ctx, q, events.MessagePreview, LinkPreviewEvent{
				ChannelID: uuid(row.ChannelID).String(), MessageID: uuid(row.ID).String(), Preview: previews[link]})
		})
		if err != nil {
			return 0, err
		}
	}
	return len(rows), nil
}

// preview returns the stored preview of a link, fetching it when there is
// none or it is old; nil when the page has nothing to show.
func (f *LinkFetcher) preview(ctx context.Context, link string) *api.LinkPreview {
	stored, err := f.Queries.GetLinkPreview(ctx, link)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		f.Log.Warn("link preview lookup failed", "err", err)
		return nil
	}
	if err != nil || time.Since(stored.FetchedAt) > linkFresh {
		stored, err = f.fetch(ctx, link)
		if err != nil {
			f.Log.Warn("link preview not stored", "err", err)
			return nil
		}
	}
	if !stored.Ok {
		return nil
	}
	out := &api.LinkPreview{Url: stored.Url, Title: stored.Title, Description: stored.Description, SiteName: stored.SiteName}
	if stored.ImageID.Valid {
		out.ImageUrl = pictureURL(stored.ImageID, false)
	}
	return out
}

// fetch reads the page's title, description and image and stores them (a
// failure is stored too, so the page is not asked again soon).
func (f *LinkFetcher) fetch(ctx context.Context, link string) (store.LinkPreview, error) {
	arg := store.UpsertLinkPreviewParams{Url: link}
	page, final, err := f.get(ctx, link, "text/html")
	if err == nil {
		meta := pageMeta(page, final)
		arg.Title, arg.Description, arg.SiteName = meta.title, meta.description, meta.site
		arg.Ok = meta.title != "" || meta.description != ""
		if arg.Ok && meta.image != "" {
			arg.ImageID = f.image(ctx, meta.image)
		}
	} else {
		f.Log.Debug("link preview fetch failed", "err", err)
	}
	return f.Queries.UpsertLinkPreview(ctx, arg)
}

// get fetches a URL, following a few redirects (each checked again), and
// returns the body when its type starts with want.
func (f *LinkFetcher) get(ctx context.Context, link, want string) ([]byte, *url.URL, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for range linkRedirects + 1 {
		u, err := f.Egress.CheckURL(link)
		if err != nil {
			return nil, nil, err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
		if err != nil {
			return nil, nil, err
		}
		req.Header.Set("User-Agent", "Cenacle-LinkPreview/1.0")
		req.Header.Set("Accept", want+",*/*;q=0.5")
		res, err := f.Egress.Do(req)
		if err != nil {
			return nil, nil, err
		}
		switch {
		case res.Status >= 300 && res.Status < 400:
			next, err := u.Parse(res.Header.Get("Location"))
			if err != nil {
				return nil, nil, err
			}
			link = next.String()
			continue
		case res.Status != http.StatusOK:
			return nil, nil, errors.New("link preview: status " + http.StatusText(res.Status))
		case !strings.HasPrefix(res.Header.Get("Content-Type"), want):
			return nil, nil, errors.New("link preview: not " + want)
		}
		return res.Body, u, nil
	}
	return nil, nil, errors.New("link preview: too many redirects")
}

// image stores a small copy of the page's image (none if it is not usable).
func (f *LinkFetcher) image(ctx context.Context, link string) pgtype.UUID {
	data, _, err := f.get(ctx, link, "image/")
	if err != nil {
		return pgtype.UUID{}
	}
	ct := preview.Sniff(data)
	if !preview.Images[ct] {
		return pgtype.UUID{}
	}
	res, err := preview.Make(data, ct)
	if err != nil {
		return pgtype.UUID{}
	}
	id, err := f.Queries.InsertPicture(ctx, store.InsertPictureParams{ContentType: res.ThumbType, Data: res.Thumb})
	if err != nil {
		f.Log.Warn("link preview image not stored", "err", err)
		return pgtype.UUID{}
	}
	return id
}

type linkMeta struct{ title, description, site, image string }

// pageMeta reads Open Graph (and Twitter card) tags, falling back to the
// page's <title> and description.
func pageMeta(page []byte, base *url.URL) linkMeta {
	var m linkMeta
	var plainTitle, plainDescription string
	doc, err := html.Parse(bytes.NewReader(page))
	if err != nil {
		return m
	}
	set := func(dst *string, v string) {
		if *dst == "" {
			*dst = v
		}
	}
	var walk func(n *html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			switch n.Data {
			case "body":
				return // metadata lives in <head>
			case "title":
				if n.FirstChild != nil && n.FirstChild.Type == html.TextNode {
					set(&plainTitle, n.FirstChild.Data)
				}
			case "meta":
				var key, content string
				for _, a := range n.Attr {
					switch strings.ToLower(a.Key) {
					case "property", "name":
						key = strings.ToLower(a.Val)
					case "content":
						content = a.Val
					}
				}
				switch key {
				case "og:title", "twitter:title":
					set(&m.title, content)
				case "og:description", "twitter:description":
					set(&m.description, content)
				case "description":
					set(&plainDescription, content)
				case "og:site_name":
					set(&m.site, content)
				case "og:image", "og:image:url", "og:image:secure_url", "twitter:image":
					set(&m.image, content)
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	set(&m.title, plainTitle)
	set(&m.description, plainDescription)
	set(&m.site, base.Hostname())
	m.title = clip(m.title, 300)
	m.description = clip(m.description, 1000)
	m.site = clip(m.site, 200)
	if m.image != "" {
		if u, err := base.Parse(strings.TrimSpace(m.image)); err == nil && (u.Scheme == "https" || u.Scheme == "http") {
			m.image = u.String()
		} else {
			m.image = ""
		}
	}
	return m
}

// clip tidies a text from a page: valid UTF-8, one line of spaces, bounded.
func clip(s string, limit int) string {
	s = strings.Join(strings.Fields(strings.ToValidUTF8(s, "")), " ")
	if utf8.RuneCountInString(s) <= limit {
		return s
	}
	r := []rune(s)
	return strings.TrimSpace(string(r[:limit-1])) + "…"
}
