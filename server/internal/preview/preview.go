// SPDX-License-Identifier: Apache-2.0

// Package preview recognizes images and makes small previews of them.
package preview

import (
	"bytes"
	"encoding/binary"
	"errors"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"

	"golang.org/x/image/draw"
	"golang.org/x/image/webp"
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

// ErrTooLarge: the image has more pixels than MaxPixels.
var ErrTooLarge = errors.New("preview: image too large")

// Make reads an image of a type in Images and makes its preview. Images that
// already fit get a preview too (it is small and re-encoded, so it carries no
// metadata).
func Make(data []byte, contentType string) (Result, error) {
	cfg, _, err := decodeConfig(data, contentType)
	if err != nil {
		return Result{}, err
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width*cfg.Height > MaxPixels {
		return Result{}, ErrTooLarge
	}
	img, err := decode(data, contentType)
	if err != nil {
		return Result{}, err
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
