// SPDX-License-Identifier: AGPL-3.0-only

// Package preview recognizes images and makes small previews of them.
package preview

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"

	"golang.org/x/image/draw"
	"golang.org/x/image/webp"
	"golang.org/x/sync/semaphore"
)

// MaxPixels bounds the images that are decoded (a "decompression bomb" of a
// few kilobytes can claim billions of pixels).
const MaxPixels = 50_000_000

// Side is the longest side of a preview.
const Side = 480

// Images is what is recognized as an image (and shown in the browser).
var Images = map[string]bool{"image/jpeg": true, "image/png": true, "image/gif": true, "image/webp": true}

// Sniff returns the content type the first bytes show (http.DetectContentType).
func Sniff(head []byte) string { return http.DetectContentType(head) }

// Result describes an image and its preview.
type Result struct {
	Width, Height int
	// Thumb is JPEG (opaque images) or PNG (with transparency).
	Thumb     []byte
	ThumbType string
}

// ErrTooLarge: the image has more pixels than MaxPixels, or would take more
// memory than DecodeBudget.
var ErrTooLarge = errors.New("preview: image too large")

// DecodeBudget bounds the memory that decoding and scaling images takes at
// once, across the server. Pixels alone do not bound it: a 500 kB PNG of
// 50 megapixels in 16-bit color decodes to 400 MB, and scaling a strip of
// 1×10 000 000 pixels takes 900 MB. An image that would need more than the
// budget gets no preview; others wait until it has room.
const DecodeBudget = 256 << 20

var decoding = semaphore.NewWeighted(DecodeBudget)

// reserve takes n bytes of the budget; release returns them.
func reserve(ctx context.Context, n int64) (release func(), err error) {
	if n > DecodeBudget {
		return nil, ErrTooLarge
	}
	if err := decoding.Acquire(ctx, n); err != nil {
		return nil, err
	}
	return func() { decoding.Release(n) }, nil
}

// decodeCost estimates the bytes the decoded image takes.
func decodeCost(cfg image.Config, data []byte, contentType string) int64 {
	var bpp int64 = 8 // 16-bit color, and what is not known
	if _, ok := cfg.ColorModel.(color.Palette); ok {
		bpp = 2 // a GIF's frames are decoded one after another
	} else {
		switch cfg.ColorModel {
		case color.GrayModel, color.AlphaModel:
			bpp = 1
		case color.Gray16Model, color.Alpha16Model:
			bpp = 2
		case color.YCbCrModel:
			bpp = 3
		case color.RGBAModel, color.NRGBAModel, color.NYCbCrAModel:
			bpp = 4
		case color.CMYKModel:
			bpp = 5
		}
	}
	if contentType == "image/jpeg" && progressive(data) {
		bpp += 12 // the coefficients of every block are kept until the end
	}
	return int64(cfg.Width) * int64(cfg.Height) * bpp
}

// scaleCost estimates the bytes x/image/draw's kernel scalers take to scale
// sw×sh pixels to dw wide: weights for every source column and row, and a
// buffer of the destination's width by the source's height.
func scaleCost(dw, sw, sh int) int64 {
	return 64*int64(sw+sh) + 32*int64(dw)*int64(sh)
}

// progressive reports whether a JPEG's frame is progressive.
func progressive(data []byte) bool {
	for p := 2; p < len(data); {
		seg := data[p:]
		if len(seg) < 4 || seg[0] != 0xff {
			return false
		}
		m := seg[1]
		if m >= 0xc0 && m <= 0xcf && m != 0xc4 && m != 0xc8 && m != 0xcc {
			return m == 0xc2 || m == 0xc6 || m == 0xca || m == 0xce
		}
		p += 2 + int(binary.BigEndian.Uint16(seg[2:4]))
	}
	return false
}

// Make reads an image of a type in Images and makes its preview. Images that
// already fit get a preview too (it is small and re-encoded, so it carries no
// metadata). It waits while other images take the DecodeBudget.
func Make(ctx context.Context, data []byte, contentType string) (Result, error) {
	cfg, _, err := decodeConfig(data, contentType)
	if err != nil {
		return Result{}, err
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width*cfg.Height > MaxPixels {
		return Result{}, ErrTooLarge
	}
	orientation := 1
	if contentType == "image/jpeg" {
		orientation = exifOrientation(data)
	}
	w, h := cfg.Width, cfg.Height
	if orientation >= 5 {
		w, h = h, w
	}
	tw, th := fit(w, h, Side)
	// Scale in stored orientation, then turn.
	sw, sh := tw, th
	if orientation >= 5 {
		sw, sh = th, tw
	}
	release, err := reserve(ctx, decodeCost(cfg, data, contentType)+scaleCost(sw, cfg.Width, cfg.Height))
	if err != nil {
		return Result{}, err
	}
	defer release()
	img, err := decode(data, contentType)
	if err != nil {
		return Result{}, err
	}
	scaled := image.NewNRGBA(image.Rect(0, 0, sw, sh))
	draw.CatmullRom.Scale(scaled, scaled.Bounds(), img, img.Bounds(), draw.Src, nil)
	thumb := orient(scaled, orientation)

	var buf bytes.Buffer
	res := Result{Width: w, Height: h}
	if opaque(thumb) {
		err = jpeg.Encode(&buf, thumb, &jpeg.Options{Quality: 82})
		res.ThumbType = "image/jpeg"
	} else {
		err = (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&buf, thumb)
		res.ThumbType = "image/png"
	}
	res.Thumb = buf.Bytes()
	return res, err
}

func decodeConfig(data []byte, contentType string) (image.Config, string, error) {
	r := bytes.NewReader(data)
	switch contentType {
	case "image/jpeg":
		c, err := jpeg.DecodeConfig(r)
		return c, "jpeg", err
	case "image/png":
		c, err := png.DecodeConfig(r)
		return c, "png", err
	case "image/gif":
		c, err := gif.DecodeConfig(r)
		return c, "gif", err
	case "image/webp":
		c, err := webp.DecodeConfig(r)
		return c, "webp", err
	}
	return image.Config{}, "", errors.New("preview: not an image")
}

// decode reads the image (the first frame of a GIF).
func decode(data []byte, contentType string) (image.Image, error) {
	r := bytes.NewReader(data)
	switch contentType {
	case "image/jpeg":
		return jpeg.Decode(r)
	case "image/png":
		return png.Decode(r)
	case "image/gif":
		return gif.Decode(r)
	case "image/webp":
		return webp.Decode(r)
	}
	return nil, errors.New("preview: not an image")
}

// fit scales w×h down to at most side on the longer side.
func fit(w, h, side int) (int, int) {
	if w <= side && h <= side {
		return w, h
	}
	if w >= h {
		return side, max(1, h*side/w)
	}
	return max(1, w*side/h), side
}

func opaque(img *image.NRGBA) bool {
	for i := 3; i < len(img.Pix); i += 4 {
		if img.Pix[i] != 0xff {
			return false
		}
	}
	return true
}

// orient turns an image upright by its EXIF orientation (1–8).
func orient(src *image.NRGBA, o int) *image.NRGBA {
	if o <= 1 || o > 8 {
		return src
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	dw, dh := w, h
	if o >= 5 {
		dw, dh = h, w
	}
	dst := image.NewNRGBA(image.Rect(0, 0, dw, dh))
	for y := range h {
		for x := range w {
			var dx, dy int
			switch o {
			case 2:
				dx, dy = w-1-x, y
			case 3:
				dx, dy = w-1-x, h-1-y
			case 4:
				dx, dy = x, h-1-y
			case 5:
				dx, dy = y, x
			case 6:
				dx, dy = h-1-y, x
			case 7:
				dx, dy = h-1-y, w-1-x
			case 8:
				dx, dy = y, w-1-x
			}
			dst.SetNRGBA(dx, dy, src.NRGBAAt(x, y))
		}
	}
	return dst
}

// exifOrientation reads the orientation tag of a JPEG (1 when absent).
func exifOrientation(data []byte) int {
	r := bytes.NewReader(data)
	var marker [2]byte
	if _, err := io.ReadFull(r, marker[:]); err != nil || marker != [2]byte{0xff, 0xd8} {
		return 1
	}
	for {
		if _, err := io.ReadFull(r, marker[:]); err != nil || marker[0] != 0xff {
			return 1
		}
		var size uint16
		if err := binary.Read(r, binary.BigEndian, &size); err != nil || size < 2 {
			return 1
		}
		seg := make([]byte, size-2)
		if _, err := io.ReadFull(r, seg); err != nil {
			return 1
		}
		if marker[1] == 0xe1 && len(seg) > 14 && string(seg[:6]) == "Exif\x00\x00" {
			return tiffOrientation(seg[6:])
		}
		if marker[1] == 0xda { // image data starts: no EXIF before it
			return 1
		}
	}
}

func tiffOrientation(t []byte) int {
	var order binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 1
	}
	off := int(order.Uint32(t[4:8]))
	if off < 8 || off+2 > len(t) {
		return 1
	}
	n := int(order.Uint16(t[off:]))
	for i := range n {
		e := off + 2 + i*12
		if e+12 > len(t) {
			return 1
		}
		if order.Uint16(t[e:]) == 0x0112 {
			if v := int(order.Uint16(t[e+8:])); v >= 1 && v <= 8 {
				return v
			}
			return 1
		}
	}
	return 1
}
