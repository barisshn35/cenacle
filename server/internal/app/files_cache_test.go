// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"net/http"
	"testing"
)

// Files are cached only on condition that the server checks access again on
// every use, and signing out empties the cache: a shared computer keeps
// nothing a session or a removal has ended.
func TestFilesAreNotReusedWithoutAccess(t *testing.T) {
	s := newStack(t, newShared(t), options{files: true})
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)
	img := s.uploadFile(ayse, general, "plan.png", "image/png", pngImage(t, 600, 300))
	if res := s.call(http.MethodPost, "/api/channels/"+general+"/messages", ayse, map[string]any{
		"body": "plan", "nonce": "files-cache-1", "file_ids": []string{img.ID},
	}, nil); res.StatusCode != http.StatusCreated {
		t.Fatalf("send = %d", res.StatusCode)
	}
	for _, path := range []string{"/content", "/thumbnail"} {
		status, hdr, _ := s.get(ayse, "/api/files/"+img.ID+path)
		if status != http.StatusOK || hdr.Get("Cache-Control") != "private, no-cache" || hdr.Get("Last-Modified") == "" {
			t.Errorf("%s = %d %q", path, status, hdr.Get("Cache-Control"))
		}
		// Revalidation asks for access each time: a 304 for the member...
		req, _ := http.NewRequest(http.MethodGet, s.srv.URL+"/api/files/"+img.ID+path, nil)
		req.Header.Set("If-Modified-Since", hdr.Get("Last-Modified"))
		req.Header.Set("Authorization", "Bearer "+ayse)
		res, err := s.client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		if res.StatusCode != http.StatusNotModified {
			t.Errorf("%s revalidated = %d", path, res.StatusCode)
		}
		// ... and nothing without a session.
		req.Header.Del("Authorization")
		if res, err = s.client.Do(req); err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s revalidated signed out = %d", path, res.StatusCode)
		}
	}
	res := s.call(http.MethodPost, "/api/auth/logout", ayse, nil, nil)
	if res.StatusCode != http.StatusOK || res.Header.Get("Clear-Site-Data") != `"cache"` {
		t.Errorf("logout = %d, Clear-Site-Data %q", res.StatusCode, res.Header.Get("Clear-Site-Data"))
	}
}
