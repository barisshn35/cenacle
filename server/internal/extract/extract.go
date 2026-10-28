// SPDX-License-Identifier: AGPL-3.0-only

// Package extract reads the text of uploaded files for search: plain text,
// PDF, Office Open XML (docx, xlsx, pptx) and OpenDocument (odt, ods, odp).
// Everything runs in the server's process without external tools; inputs are
// bounded, and a file that cannot be read simply has no text.
package extract

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"io"
	"path"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ledongthuc/pdf"
)

// MaxText bounds the text kept per file (characters).
const MaxText = 200_000

// MaxSize bounds the files read (bytes); larger ones are not indexed.
const MaxSize = 25 << 20

// ErrUnsupported: no text can be read from this kind of file.
var ErrUnsupported = errors.New("extract: unsupported file type")

// Supported reports whether a file's text can be read.
func Supported(contentType, name string) bool { return kind(contentType, name) != "" }

func kind(contentType, name string) string {
	ct := strings.ToLower(strings.TrimSpace(strings.SplitN(contentType, ";", 2)[0]))
	ext := strings.ToLower(path.Ext(name))
	switch {
	case ct == "application/pdf" || ext == ".pdf":
		return "pdf"
	case ext == ".docx" || ct == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		return "docx"
	case ext == ".xlsx" || ct == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
		return "xlsx"
	case ext == ".pptx" || ct == "application/vnd.openxmlformats-officedocument.presentationml.presentation":
		return "pptx"
	case ext == ".odt" || ext == ".ods" || ext == ".odp" || strings.HasPrefix(ct, "application/vnd.oasis.opendocument."):
		return "odf"
	case strings.HasPrefix(ct, "text/") || ct == "application/json" || ct == "application/xml" ||
		ext == ".txt" || ext == ".md" || ext == ".csv" || ext == ".log" || ext == ".json":
		return "text"
	}
	return ""
}

// Text returns the readable text of a file (at most MaxText characters).
// Reading stops early (with what was read) when ctx ends.
func Text(ctx context.Context, r io.ReaderAt, size int64, contentType, name string) (string, error) {
	if size > MaxSize {
		return "", ErrUnsupported
	}
	var (
		out string
		err error
	)
	switch kind(contentType, name) {
	case "text":
		b, rerr := io.ReadAll(io.NewSectionReader(r, 0, size))
		if rerr != nil {
			return "", rerr
		}
		if !utf8.Valid(b) {
			b = bytes.ToValidUTF8(b, []byte(" "))
		}
		out = string(b)
	case "pdf":
		out, err = pdfText(ctx, r, size)
	case "docx":
		out, err = zipText(ctx, r, size, func(n string) bool {
			return n == "word/document.xml" || strings.HasPrefix(n, "word/header") || strings.HasPrefix(n, "word/footer")
		}, "p")
	case "pptx":
		out, err = zipText(ctx, r, size, func(n string) bool { return strings.HasPrefix(n, "ppt/slides/slide") && strings.HasSuffix(n, ".xml") }, "p")
	case "xlsx":
		out, err = zipText(ctx, r, size, func(n string) bool { return n == "xl/sharedStrings.xml" || strings.HasPrefix(n, "xl/worksheets/sheet") }, "si")
	case "odf":
		out, err = zipText(ctx, r, size, func(n string) bool { return n == "content.xml" }, "p")
	default:
		return "", ErrUnsupported
	}
	if err != nil {
		return "", err
	}
	return clip(normalize(out)), nil
}

// Bounds of reading a PDF. The library interprets a page's whole content
// stream and keeps everything it decodes, and a few kilobytes of a PDF can
// inflate to gigabytes: decompressed sizes are measured (and stopped at the
// bound) before anything is interpreted, decoded text is capped as it grows,
// and a file gets a time budget. Ordinary pages hold well under 100 KiB of
// content and fonts' ToUnicode maps a few KiB.
const (
	maxPageContent = 2 << 20  // decompressed content stream of one page
	maxPDFContent  = 32 << 20 // all pages together
	maxCMap        = 1 << 20  // one font's ToUnicode map
	pdfTime        = 30 * time.Second
	// decodeChunk is how many bytes of a string are decoded at once (a
	// multiple of the 1, 2 and 4 byte codes): one code may map to a long
	// text, so a long string is never decoded in one go.
	decodeChunk = 16
)

// errStop ends the interpretation of a page (enough text, or out of time).
var errStop = errors.New("extract: stop")

// timeUp tells when reading a file must stop: its time budget is spent or
// the caller gave up.
func timeUp(ctx context.Context, deadline time.Time) bool {
	return ctx.Err() != nil || time.Now().After(deadline)
}

// pdfText reads the text of every page; a broken PDF is an error, not a panic.
func pdfText(ctx context.Context, r io.ReaderAt, size int64) (out string, err error) {
	defer func() {
		if p := recover(); p != nil {
			out, err = "", errors.New("extract: unreadable PDF")
		}
	}()
	doc, err := pdf.NewReader(r, size)
	if err != nil {
		return "", err
	}
	deadline := time.Now().Add(pdfTime)
	budget := int64(maxPDFContent)
	var b strings.Builder
	for i := 1; i <= doc.NumPage() && b.Len() < MaxText*4 && !timeUp(ctx, deadline); i++ {
		page := doc.Page(i)
		if page.V.IsNull() {
			continue
		}
		content := page.V.Key("Contents")
		n, ok := streamSize(content, maxPageContent)
		if !ok {
			continue // too large, not a single stream, or unreadable
		}
		if budget -= n; budget < 0 {
			break
		}
		pageText(ctx, &b, page, content, deadline)
		b.WriteString("\n")
	}
	return b.String(), nil
}

// streamSize measures a stream's decompressed size, reading at most limit+1
// bytes; ok is false when it is larger than limit or cannot be read.
func streamSize(v pdf.Value, limit int64) (n int64, ok bool) {
	if v.Kind() != pdf.Stream {
		return 0, false
	}
	defer func() {
		if recover() != nil {
			n, ok = 0, false
		}
	}()
	rc := v.Reader()
	defer func() { _ = rc.Close() }()
	n, err := io.Copy(io.Discard, io.LimitReader(rc, limit+1))
	return n, err == nil && n <= limit
}

// rawEncoding passes codes through (unknown or oversized font maps).
type rawEncoding struct{}

func (rawEncoding) Decode(raw string) string { return raw }

// pageText appends a page's text to b (as Page.GetPlainText does, but within
// the bounds): a broken page adds what was read before it broke.
func pageText(ctx context.Context, b *strings.Builder, page pdf.Page, content pdf.Value, deadline time.Time) {
	defer func() { _ = recover() }() // errStop or a malformed page
	fonts := page.Resources().Key("Font")
	encoders := map[string]pdf.TextEncoding{}
	var enc pdf.TextEncoding = rawEncoding{}
	show := func(s string) {
		for len(s) > 0 {
			k := min(len(s), decodeChunk)
			b.WriteString(enc.Decode(s[:k]))
			s = s[k:]
			if b.Len() >= MaxText*4 || timeUp(ctx, deadline) {
				panic(errStop)
			}
		}
	}
	pdf.Interpret(content, func(stk *pdf.Stack, op string) {
		n := stk.Len()
		args := make([]pdf.Value, n)
		for i := n - 1; i >= 0; i-- {
			args[i] = stk.Pop()
		}
		if timeUp(ctx, deadline) {
			panic(errStop)
		}
		switch op {
		case "T*":
			show("\n")
		case "Tf":
			if len(args) != 2 {
				return
			}
			name := args[0].Name()
			e, ok := encoders[name]
			if !ok {
				e = rawEncoding{}
				font := fonts.Key(name)
				// Font.Encoder parses the ToUnicode map on every call: once
				// per font, and only a map of sensible size.
				if m := font.Key("ToUnicode"); font.IsNull() {
					// an unknown font: codes as they are
				} else if m.Kind() != pdf.Stream || func() bool { _, ok := streamSize(m, maxCMap); return ok }() {
					e = (pdf.Font{V: font}).Encoder()
				}
				encoders[name] = e
			}
			enc = e
		case "\"", "'", "Tj":
			if len(args) > 0 {
				show(args[len(args)-1].RawString())
			}
		case "TJ":
			if len(args) != 1 {
				return
			}
			v := args[0]
			for i := 0; i < v.Len(); i++ {
				if x := v.Index(i); x.Kind() == pdf.String {
					show(x.RawString())
				}
			}
		}
	})
}

// Bounds of reading an Office or OpenDocument file. Its parts are deflated
// XML, and markup without text inflates about a thousandfold and is never
// cut short by the text bound: the parts read, their inflated bytes together
// and the time are bounded per file. A long book is a few MiB of XML, and a
// presentation a few hundred slides. Variables so tests can lower them.
var (
	maxZipPart    int64 = 50 << 20 // inflated bytes of one part
	maxZipContent int64 = 64 << 20 // all parts together
	maxZipParts         = 1000
	zipTime             = 30 * time.Second
)

// zipCheckEvery is how many XML tokens are read between looks at the clock.
const zipCheckEvery = 1024

// zipText collects the character data of the XML parts a name filter picks,
// in name order, with a line break after each paragraph element.
func zipText(ctx context.Context, r io.ReaderAt, size int64, want func(string) bool, paragraph string) (string, error) {
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return "", err
	}
	files := make([]*zip.File, 0, 8)
	for _, f := range zr.File {
		if want(f.Name) && f.UncompressedSize64 < uint64(maxZipPart) { //nolint:gosec // a positive bound
			files = append(files, f)
		}
	}
	sort.Slice(files, func(i, j int) bool { return naturalLess(files[i].Name, files[j].Name) })
	if len(files) > maxZipParts {
		files = files[:maxZipParts]
	}
	deadline := time.Now().Add(zipTime)
	budget := maxZipContent
	var b strings.Builder
	for _, f := range files {
		if budget <= 0 || b.Len() >= MaxText*4 || timeUp(ctx, deadline) {
			break
		}
		rc, err := f.Open()
		if err != nil {
			continue
		}
		// The declared sizes are the archive's word: count what inflates.
		part := &countingReader{r: io.LimitReader(rc, min(maxZipPart, budget))}
		dec := xml.NewDecoder(part)
		for tokens := 1; b.Len() < MaxText*4; tokens++ {
			if tokens%zipCheckEvery == 0 && timeUp(ctx, deadline) {
				break
			}
			tok, err := dec.Token()
			if err != nil {
				break
			}
			switch t := tok.(type) {
			case xml.CharData:
				b.Write(t)
			case xml.EndElement:
				if t.Name.Local == paragraph || t.Name.Local == "tab" || t.Name.Local == "br" {
					b.WriteString("\n")
				}
			case xml.StartElement:
				// Cells of a sheet and shapes of a slide: keep words apart.
				if t.Name.Local == "c" || t.Name.Local == "v" || t.Name.Local == "table-cell" {
					b.WriteString(" ")
				}
			}
		}
		_ = rc.Close()
		budget -= part.n
	}
	return b.String(), nil
}

// countingReader counts the bytes read through it.
type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

// naturalLess orders slide2 before slide10.
func naturalLess(a, b string) bool {
	if len(a) != len(b) {
		return len(a) < len(b)
	}
	return a < b
}

// normalize collapses runs of spaces and blank lines.
func normalize(s string) string {
	lines := strings.Split(strings.ReplaceAll(s, "\r", ""), "\n")
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		if l = strings.Join(strings.Fields(l), " "); l != "" {
			out = append(out, l)
		}
	}
	return strings.Join(out, "\n")
}

func clip(s string) string {
	if utf8.RuneCountInString(s) <= MaxText {
		return s
	}
	r := []rune(s)
	return string(r[:MaxText])
}
