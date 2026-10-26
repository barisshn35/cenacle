// SPDX-License-Identifier: AGPL-3.0-only

package preview

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/color/palette"
	"image/gif"
	"image/png"
	"testing"
)

func pngOf(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for x := range w {
		img.Set(x, 0, color.NRGBA{R: 200, A: 255})
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func gifOf(t *testing.T, frames, side int) []byte {
	t.Helper()
	g := &gif.GIF{}
	for i := range frames {
		f := image.NewPaletted(image.Rect(0, 0, side, side), palette.Plan9)
		f.SetColorIndex(i%side, 0, uint8(i))
		g.Image = append(g.Image, f)
		g.Delay = append(g.Delay, 10)
	}
	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, g); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestMakePicture(t *testing.T) {
	// A wide image becomes a square of the picture side.
	p, err := MakePicture(t.Context(), pngOf(t, 900, 300))
	if err != nil || p.ContentType != "image/png" || p.Still != nil {
		t.Fatalf("png: %+v %v", p.ContentType, err)
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(p.Data))
	if err != nil || cfg.Width != PictureSide || cfg.Height != PictureSide {
		t.Errorf("png size = %dx%d %v", cfg.Width, cfg.Height, err)
	}
	// Small images keep their size.
	small, _ := MakePicture(t.Context(), pngOf(t, 40, 60))
	if cfg, _ := png.DecodeConfig(bytes.NewReader(small.Data)); cfg.Width != 40 || cfg.Height != 40 {
		t.Errorf("small = %dx%d", cfg.Width, cfg.Height)
	}

	// An animated GIF stays animated, with a still first frame.
	anim := gifOf(t, 5, 64)
	if n := gifFrames(anim); n != 5 {
		t.Errorf("frames = %d", n)
	}
	p, err = MakePicture(t.Context(), anim)
	if err != nil || p.ContentType != "image/gif" || !bytes.Equal(p.Data, anim) || p.Still == nil {
		t.Fatalf("gif: %s %v", p.ContentType, err)
	}
	// One frame: an ordinary picture.
	if p, _ := MakePicture(t.Context(), gifOf(t, 1, 64)); p.ContentType != "image/png" {
		t.Errorf("single-frame gif = %s", p.ContentType)
	}
	// Too large to keep moving.
	if _, err := MakePicture(t.Context(), gifOf(t, 2, MaxAnimatedSide+8)); !errors.Is(err, ErrNotPicture) {
		t.Errorf("large gif = %v", err)
	}
	// Not an image.
	if _, err := MakePicture(t.Context(), []byte("<svg xmlns='http://www.w3.org/2000/svg'/>")); !errors.Is(err, ErrNotPicture) {
		t.Errorf("svg = %v", err)
	}
	// Truncated GIF: frames seen so far.
	if n := gifFrames(anim[:len(anim)/2]); n >= 5 {
		t.Errorf("truncated frames = %d", n)
	}
}
