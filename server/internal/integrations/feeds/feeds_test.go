// SPDX-License-Identifier: AGPL-3.0-only

package feeds

import (
	"errors"
	"testing"
)

func TestParse(t *testing.T) {
	rssDoc := `<?xml version="1.0" encoding="ISO-8859-9"?><rss version="2.0"><channel><title>Blog</title>
<item><title>Yeni &amp; güzel</title><link>https://example.com/1</link><guid>g1</guid><description>&lt;p&gt;Merhaba &lt;b&gt;dünya&lt;/b&gt;&lt;/p&gt;</description></item>
<item><title>Eski</title><link>https://example.com/0</link></item></channel></rss>`
	f, err := Parse([]byte(rssDoc))
	if err != nil || f.Title != "Blog" || len(f.Items) != 2 {
		t.Fatalf("rss = %+v %v", f, err)
	}
	if it := f.Items[0]; it.ID != "g1" || it.Title != "Yeni & güzel" || it.Summary != "Merhaba dünya" {
		t.Errorf("rss item = %+v", it)
	}
	if f.Items[1].ID != "https://example.com/0" {
		t.Errorf("id from link = %q", f.Items[1].ID)
	}

	atomDoc := `<feed xmlns="http://www.w3.org/2005/Atom"><title>Releases</title>
<entry><id>tag:x,1</id><title>v1.0</title><link rel="alternate" href="https://example.com/v1"/><content type="html">&lt;p&gt;Notes&lt;/p&gt;</content></entry></feed>`
	f, err = Parse([]byte(atomDoc))
	if err != nil || f.Title != "Releases" || len(f.Items) != 1 || f.Items[0].Link != "https://example.com/v1" || f.Items[0].Summary != "Notes" {
		t.Fatalf("atom = %+v %v", f, err)
	}
	if _, err := Parse([]byte("<html><body>no</body></html>")); !errors.Is(err, ErrNotAFeed) {
		t.Errorf("html = %v", err)
	}
}
