// SPDX-License-Identifier: AGPL-3.0-only

// Package feeds reads RSS 2.0 and Atom feeds.
package feeds

import (
	"bytes"
	"encoding/xml"
	"errors"
	"html"
	"io"
	"regexp"
	"strings"
)

// Item is one entry of a feed.
type Item struct {
	// ID tells items apart: the guid or id, else the link.
	ID      string
	Title   string
	Link    string
	Summary string
}

// Feed is a feed's title and items, as they come (usually newest first).
type Feed struct {
	Title string
	Items []Item
}

type rss struct {
	Channel struct {
		Title string `xml:"title"`
		Items []struct {
			Title       string `xml:"title"`
			Link        string `xml:"link"`
			GUID        string `xml:"guid"`
			Description string `xml:"description"`
		} `xml:"item"`
	} `xml:"channel"`
}

type atom struct {
	Title   string `xml:"title"`
	Entries []struct {
		Title string `xml:"title"`
		ID    string `xml:"id"`
		Links []struct {
			Href string `xml:"href,attr"`
			Rel  string `xml:"rel,attr"`
		} `xml:"link"`
		Summary string `xml:"summary"`
		Content string `xml:"content"`
	} `xml:"entry"`
}

var tagRE = regexp.MustCompile(`(?s)<[^>]+>`)
var spaceRE = regexp.MustCompile(`\s+`)

// Text is HTML as plain text on one line.
func Text(s string) string {
	return strings.TrimSpace(spaceRE.ReplaceAllString(html.UnescapeString(tagRE.ReplaceAllString(s, " ")), " "))
}

// ErrNotAFeed is a document that is neither RSS nor Atom.
var ErrNotAFeed = errors.New("not an RSS or Atom feed")

// Parse reads a feed.
func Parse(raw []byte) (Feed, error) {
	dec := xml.NewDecoder(bytes.NewReader(raw))
	// Feeds declare other encodings now and then; their text is read as is.
	dec.CharsetReader = func(_ string, r io.Reader) (io.Reader, error) { return r, nil }
	var root xml.StartElement
	for {
		tok, err := dec.Token()
		if err != nil {
			return Feed{}, ErrNotAFeed
		}
		if se, ok := tok.(xml.StartElement); ok {
			root = se
			break
		}
	}
	switch root.Name.Local {
	case "rss":
		var doc rss
		if err := dec.DecodeElement(&doc, &root); err != nil {
			return Feed{}, ErrNotAFeed
		}
		out := Feed{Title: Text(doc.Channel.Title)}
		for _, it := range doc.Channel.Items {
			id := strings.TrimSpace(it.GUID)
			if id == "" {
				id = strings.TrimSpace(it.Link)
			}
			if id == "" {
				id = it.Title
			}
			out.Items = append(out.Items, Item{ID: id, Title: Text(it.Title), Link: strings.TrimSpace(it.Link), Summary: Text(it.Description)})
		}
		return out, nil
	case "feed":
		var doc atom
		if err := dec.DecodeElement(&doc, &root); err != nil {
			return Feed{}, ErrNotAFeed
		}
		out := Feed{Title: Text(doc.Title)}
		for _, e := range doc.Entries {
			link := ""
			for _, l := range e.Links {
				if l.Rel == "" || l.Rel == "alternate" {
					link = l.Href
					break
				}
			}
			summary := e.Summary
			if summary == "" {
				summary = e.Content
			}
			id := strings.TrimSpace(e.ID)
			if id == "" {
				id = link
			}
			out.Items = append(out.Items, Item{ID: id, Title: Text(e.Title), Link: link, Summary: Text(summary)})
		}
		return out, nil
	}
	return Feed{}, ErrNotAFeed
}
