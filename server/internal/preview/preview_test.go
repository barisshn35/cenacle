// SPDX-License-Identifier: AGPL-3.0-only

package preview

import (
	"bytes"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"testing"
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
	res, err := Make(big, "image/jpeg")
	if err != nil || res.Width != 1600 || res.Height != 900 || res.ThumbType != "image/jpeg" {
		t.Fatalf("jpeg = %+v %v", res, err)
	}
	cfg, _ := jpeg.DecodeConfig(bytes.NewReader(res.Thumb))
	if cfg.Width != 480 || cfg.Height != 270 {
		t.Errorf("thumb = %dx%d", cfg.Width, cfg.Height)
	}

	// Transparency keeps PNG; small images keep their size.
	clear := encode(t, solid(100, 50, color.NRGBA{0, 0, 0, 0}), "png")
	res, err = Make(clear, "image/png")
	if err != nil || res.ThumbType != "image/png" || res.Width != 100 {
		t.Errorf("png = %+v %v", res, err)
	}
	if res, err = Make(encode(t, solid(30, 600, color.NRGBA{1, 2, 3, 255}), "gif"), "image/gif"); err != nil || res.Height != 600 {
		t.Errorf("gif = %+v %v", res, err)
	}
	if _, err := Make([]byte("not an image"), "image/png"); err == nil {
		t.Error("garbage decoded")
	}
}

func TestDecompressionBomb(t *testing.T) {
	// A PNG header that claims 100000×100000 pixels.
	var buf bytes.Buffer
	buf.Write([]byte("\x89PNG\r\n\x1a\n"))
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], 100000)
	binary.BigEndian.PutUint32(ihdr[4:], 100000)
	ihdr[8], ihdr[9] = 8, 6
	binary.Write(&buf, binary.BigEndian, uint32(13)) //nolint:errcheck
	buf.WriteString("IHDR")
	buf.Write(ihdr)
	crc := crc32.NewIEEE()
	crc.Write([]byte("IHDR"))
	crc.Write(ihdr)
	binary.Write(&buf, binary.BigEndian, crc.Sum32()) //nolint:errcheck
	if _, err := Make(buf.Bytes(), "image/png"); !errors.Is(err, ErrTooLarge) {
		t.Errorf("bomb = %v", err)
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
	res, err := Make(photo, "image/jpeg")
	if err != nil || res.Width != 400 || res.Height != 800 {
		t.Fatalf("rotated = %+v %v", res, err)
	}
	cfg, _ := jpeg.DecodeConfig(bytes.NewReader(res.Thumb))
	if cfg.Width != 240 || cfg.Height != 480 {
		t.Errorf("rotated thumb = %dx%d", cfg.Width, cfg.Height)
	}
}
