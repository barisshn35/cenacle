// SPDX-License-Identifier: AGPL-3.0-only

package preview

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/png"

	"golang.org/x/image/draw"
)

// Profile pictures and workspace icons.
const (
	// PictureSide is the side of a re-encoded (square) picture.
	PictureSide = 256
	// MaxUpload bounds what may be uploaded.
	MaxUpload = 5 << 20
	// MaxAnimated bounds an animated GIF, which is kept as uploaded.
	MaxAnimated = 2 << 20
	// MaxAnimatedSide bounds its canvas.
	MaxAnimatedSide = 1024
)

// ErrNotPicture: not an image Pictures accepts, or too large for one.
var ErrNotPicture = errors.New("preview: not a usable picture")

// Picture is a stored profile picture or icon.
type Picture struct {
	Data        []byte
	ContentType string // image/png or image/gif
	// Still is the first frame (PNG) of an animated picture, else nil.
	Still []byte
}

// MakePicture turns an uploaded image into a picture: a square PNG of
// PictureSide (cut from the middle; JPEG orientation applied), or an animated
// GIF kept as it is (with a still first frame), so it keeps moving.
func MakePicture(ctx context.Context, data []byte) (Picture, error) {
	ct := Sniff(data)
	if !Images[ct] || len(data) > MaxUpload {
		return Picture{}, ErrNotPicture
	}
	cfg, _, err := decodeConfig(data, ct)
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width*cfg.Height > MaxPixels {
		return Picture{}, ErrNotPicture
	}
	side := min(cfg.Width, cfg.Height)
	release, err := reserve(ctx, decodeCost(cfg, data, ct)+scaleCost(min(side, PictureSide), side, side))
	if errors.Is(err, ErrTooLarge) {
		return Picture{}, ErrNotPicture
	} else if err != nil {
		return Picture{}, err
	}
	defer release()
	img, err := decode(data, ct) // a GIF's first frame
	if err != nil {
		return Picture{}, ErrNotPicture
	}
	orientation := 1
	if ct == "image/jpeg" {
		orientation = exifOrientation(data)
	}
	square, err := encodeSquare(img, orientation)
	if err != nil {
		return Picture{}, err
	}
	if ct == "image/gif" && gifFrames(data) > 1 {
		if len(data) > MaxAnimated || cfg.Width > MaxAnimatedSide || cfg.Height > MaxAnimatedSide {
			return Picture{}, ErrNotPicture
		}
		return Picture{Data: data, ContentType: "image/gif", Still: square}, nil
	}
	return Picture{Data: square, ContentType: "image/png"}, nil
}

// encodeSquare cuts the middle square, scales it to PictureSide (smaller
// images keep their size) and encodes it as PNG.
func encodeSquare(img image.Image, orientation int) ([]byte, error) {
	b := img.Bounds()
	side := min(b.Dx(), b.Dy())
	x0 := b.Min.X + (b.Dx()-side)/2
	y0 := b.Min.Y + (b.Dy()-side)/2
	out := min(side, PictureSide)
	scaled := image.NewNRGBA(image.Rect(0, 0, out, out))
	draw.CatmullRom.Scale(scaled, scaled.Bounds(), img, image.Rect(x0, y0, x0+side, y0+side), draw.Src, nil)
	var buf bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.BestCompression}).Encode(&buf, orient(scaled, orientation)); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// gifFrames counts the images of a GIF by walking its blocks, without
// decompressing them (decoding every frame of a crafted file could take a lot
// of memory). A malformed file counts the frames seen so far.
func gifFrames(data []byte) int {
	if len(data) < 13 {
		return 0
	}
	p := 13
	if data[10]&0x80 != 0 { // global color table
		p += 3 << (int(data[10]&7) + 1)
	}
	frames := 0
	skipSubBlocks := func() bool {
		for p < len(data) {
			n := int(data[p])
			p++
			if n == 0 {
				return true
			}
			p += n
		}
		return false
	}
	for p < len(data) {
		switch data[p] {
		case 0x21: // extension: label, then sub-blocks
			p += 2
			if !skipSubBlocks() {
				return frames
			}
		case 0x2C: // image descriptor
			if p+10 > len(data) {
				return frames
			}
			flags := data[p+9]
			p += 10
			if flags&0x80 != 0 { // local color table
				p += 3 << (int(flags&7) + 1)
			}
			p++ // LZW minimum code size
			if !skipSubBlocks() {
				return frames
			}
			frames++
		default: // 0x3B trailer, or garbage
			return frames
		}
	}
	return frames
}
