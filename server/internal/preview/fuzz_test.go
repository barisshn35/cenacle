// SPDX-License-Identifier: AGPL-3.0-only

package preview

import (
	"bytes"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"testing"
)

// Uploaded and fetched images are untrusted. Any bytes may be refused; none
// may crash or exhaust the server, and a preview stays within its bounds.
// The seeds run with every test; `go test -fuzz=Fuzz<Name> ./internal/preview`
// looks further.

func seedImages(f *testing.F) [][]byte {
	img := image.NewNRGBA(image.Rect(0, 0, 3, 2))
	img.Set(1, 1, color.NRGBA{200, 10, 10, 128})
	var out [][]byte
	for _, enc := range []func(*bytes.Buffer) error{
		func(b *bytes.Buffer) error { return png.Encode(b, img) },
		func(b *bytes.Buffer) error { return jpeg.Encode(b, img, nil) },
		func(b *bytes.Buffer) error { return gif.Encode(b, img, nil) },
	} {
		var b bytes.Buffer
		if err := enc(&b); err != nil {
			f.Fatal(err)
		}
		out = append(out, b.Bytes())
	}
	// A JPEG with an EXIF orientation segment, and a PNG that claims to be huge.
	out = append(out, append([]byte{0xff, 0xd8, 0xff, 0xe1, 0x00, 0x16, 'E', 'x', 'i', 'f', 0, 0, 'M', 'M', 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6}, out[1][2:]...))
	huge := append([]byte{}, out[0]...)
	copy(huge[16:24], []byte{0x7f, 0xff, 0xff, 0xff, 0x7f, 0xff, 0xff, 0xff})
	return append(out, huge)
}

func FuzzMake(f *testing.F) {
	for _, s := range seedImages(f) {
		for _, ct := range []string{"image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"} {
			f.Add(s, ct)
		}
	}
	f.Fuzz(func(t *testing.T, data []byte, contentType string) {
		res, err := Make(t.Context(), data, contentType)
		if err != nil {
			return
		}
		if res.Width <= 0 || res.Height <= 0 || res.Width*res.Height > MaxPixels {
			t.Fatalf("size %dx%d", res.Width, res.Height)
		}
		if res.Thumb == nil {
			return
		}
		cfg, _, err := image.DecodeConfig(bytes.NewReader(res.Thumb))
		if err != nil || cfg.Width > Side || cfg.Height > Side {
			t.Fatalf("thumbnail %dx%d %v", cfg.Width, cfg.Height, err)
		}
		if res.ThumbType != "image/jpeg" && res.ThumbType != "image/png" {
			t.Fatalf("thumbnail type %q", res.ThumbType)
		}
	})
}

func FuzzMakePicture(f *testing.F) {
	for _, s := range seedImages(f) {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		p, err := MakePicture(t.Context(), data)
		if err != nil {
			return
		}
		if len(p.Data) == 0 || (p.ContentType != "image/png" && p.ContentType != "image/gif") {
			t.Fatalf("picture %q of %d bytes", p.ContentType, len(p.Data))
		}
	})
}
