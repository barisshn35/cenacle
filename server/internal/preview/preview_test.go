// SPDX-License-Identifier: AGPL-3.0-only

package preview

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"testing"
	"time"
)

func encode(t *testing.T, img image.Image, kind string) []byte {
	t.Helper()
	var buf bytes.Buffer
	var err error
	switch kind {
	case "png":
		err = png.Encode(&buf, img)
	case "jpeg":
		err = jpeg.Encode(&buf, img, nil)
	case "gif":
		err = gif.Encode(&buf, img, nil)
	}
	if err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func solid(w, h int, c color.NRGBA) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = c.R, c.G, c.B, c.A
	}
	return img
}

func TestMake(t *testing.T) {
	big := encode(t, solid(1600, 900, color.NRGBA{200, 10, 10, 255}), "jpeg")
	if Sniff(big) != "image/jpeg" {
		t.Fatalf("sniff = %s", Sniff(big))
	}
	res, err := Make(t.Context(), big, "image/jpeg")
	if err != nil || res.Width != 1600 || res.Height != 900 || res.ThumbType != "image/jpeg" {
		t.Fatalf("jpeg = %+v %v", res, err)
	}
	cfg, _ := jpeg.DecodeConfig(bytes.NewReader(res.Thumb))
	if cfg.Width != 480 || cfg.Height != 270 {
		t.Errorf("thumb = %dx%d", cfg.Width, cfg.Height)
	}

	// Transparency keeps PNG; small images keep their size.
	clear := encode(t, solid(100, 50, color.NRGBA{0, 0, 0, 0}), "png")
	res, err = Make(t.Context(), clear, "image/png")
	if err != nil || res.ThumbType != "image/png" || res.Width != 100 {
		t.Errorf("png = %+v %v", res, err)
	}
	if res, err = Make(t.Context(), encode(t, solid(30, 600, color.NRGBA{1, 2, 3, 255}), "gif"), "image/gif"); err != nil || res.Height != 600 {
		t.Errorf("gif = %+v %v", res, err)
	}
	if _, err := Make(t.Context(), []byte("not an image"), "image/png"); err == nil {
		t.Error("garbage decoded")
	}
}

// pngHeader is the start of a PNG that claims w×h pixels of the given bit
// depth and color type; enough for its size to be read, not to be decoded.
func pngHeader(w, h uint32, depth, colorType byte) []byte {
	var buf bytes.Buffer
	buf.Write([]byte("\x89PNG\r\n\x1a\n"))
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], w)
	binary.BigEndian.PutUint32(ihdr[4:], h)
	ihdr[8], ihdr[9] = depth, colorType
	binary.Write(&buf, binary.BigEndian, uint32(13)) //nolint:errcheck
	buf.WriteString("IHDR")
	buf.Write(ihdr)
	crc := crc32.NewIEEE()
	crc.Write([]byte("IHDR"))
	crc.Write(ihdr)
	binary.Write(&buf, binary.BigEndian, crc.Sum32()) //nolint:errcheck
	return buf.Bytes()
}

func TestDecompressionBomb(t *testing.T) {
	if _, err := Make(t.Context(), pngHeader(100000, 100000, 8, 6), "image/png"); !errors.Is(err, ErrTooLarge) {
		t.Errorf("bomb = %v", err)
	}
}

// Images within MaxPixels can still take more memory than a server has: they
// are refused before they are decoded.
func TestMemoryBombs(t *testing.T) {
	for name, data := range map[string][]byte{
		"49 megapixels of 16-bit color": pngHeader(7000, 7000, 16, 6),
		"a strip of 1×10 000 000":       pngHeader(1, 10_000_000, 8, 0),
	} {
		if _, err := Make(t.Context(), data, "image/png"); !errors.Is(err, ErrTooLarge) {
			t.Errorf("%s: preview = %v", name, err)
		}
	}
	if _, err := MakePicture(t.Context(), pngHeader(7000, 7000, 16, 6)); !errors.Is(err, ErrNotPicture) {
		t.Errorf("picture = %v", err)
	}
	// A photo is not one: it gets as far as decoding (and this one has no data).
	if _, err := Make(t.Context(), pngHeader(6000, 4000, 8, 6), "image/png"); err == nil || errors.Is(err, ErrTooLarge) {
		t.Errorf("photo = %v", err)
	}
}

func TestDecodeBudgetWaits(t *testing.T) {
	release, err := reserve(t.Context(), DecodeBudget)
	if err != nil {
		t.Fatal(err)
	}
	small := encode(t, solid(40, 30, color.NRGBA{1, 2, 3, 255}), "png")
	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()
	if _, err := Make(ctx, small, "image/png"); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("while the budget is taken: %v", err)
	}
	release()
	if _, err := Make(t.Context(), small, "image/png"); err != nil {
		t.Errorf("after: %v", err)
	}
}

func TestProgressive(t *testing.T) {
	baseline := encode(t, solid(8, 8, color.NRGBA{1, 2, 3, 255}), "jpeg")
	if progressive(baseline) {
		t.Error("baseline read as progressive")
	}
	// SOI, an APP0 segment, then SOF2.
	prog := []byte{0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc2, 0, 11, 8, 0, 8, 0, 8, 1, 1, 0x11, 0}
	if !progressive(prog) {
		t.Error("progressive not seen")
	}
	if progressive([]byte{0xff, 0xd8, 0xff}) {
		t.Error("truncated read as progressive")
	}
}

// withOrientation inserts an EXIF segment with an orientation into a JPEG.
func withOrientation(data []byte, o uint16) []byte {
	tiff := []byte{'M', 'M', 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, byte(o), 0, 0, 0, 0, 0, 0}
	seg := append([]byte("Exif\x00\x00"), tiff...)
	var out bytes.Buffer
	out.Write(data[:2])
	out.Write([]byte{0xff, 0xe1})
	binary.Write(&out, binary.BigEndian, uint16(len(seg)+2)) //nolint:errcheck
	out.Write(seg)
	out.Write(data[2:])
	return out.Bytes()
}

func TestOrientation(t *testing.T) {
	photo := withOrientation(encode(t, solid(800, 400, color.NRGBA{9, 9, 9, 255}), "jpeg"), 6)
	if o := exifOrientation(photo); o != 6 {
		t.Fatalf("orientation = %d", o)
	}
	res, err := Make(t.Context(), photo, "image/jpeg")
	if err != nil || res.Width != 400 || res.Height != 800 {
		t.Fatalf("rotated = %+v %v", res, err)
	}
	cfg, _ := jpeg.DecodeConfig(bytes.NewReader(res.Thumb))
	if cfg.Width != 240 || cfg.Height != 480 {
		t.Errorf("rotated thumb = %dx%d", cfg.Width, cfg.Height)
	}
}
