// SPDX-License-Identifier: AGPL-3.0-only

// Package extract reads the text of uploaded files for search: plain text,
// PDF, Office Open XML (docx, xlsx, pptx) and OpenDocument (odt, ods, odp).
// Everything runs in the server's process without external tools; inputs are
// bounded, and a file that cannot be read simply has no text.
package extract

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"path"
	"sort"
	"strings"
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
func Text(r io.ReaderAt, size int64, contentType, name string) (string, error) {
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
		out, err = pdfText(r, size)
	case "docx":
		out, err = zipText(r, size, func(n string) bool {
			return n == "word/document.xml" || strings.HasPrefix(n, "word/header") || strings.HasPrefix(n, "word/footer")
		}, "p")
	case "pptx":
		out, err = zipText(r, size, func(n string) bool { return strings.HasPrefix(n, "ppt/slides/slide") && strings.HasSuffix(n, ".xml") }, "p")
	case "xlsx":
		out, err = zipText(r, size, func(n string) bool { return n == "xl/sharedStrings.xml" || strings.HasPrefix(n, "xl/worksheets/sheet") }, "si")
	case "odf":
		out, err = zipText(r, size, func(n string) bool { return n == "content.xml" }, "p")
	default:
		return "", ErrUnsupported
	}
	if err != nil {
		return "", err
	}
	return clip(normalize(out)), nil
}

// pdfText reads the text of every page; a broken PDF is an error, not a panic.
func pdfText(r io.ReaderAt, size int64) (out string, err error) {
	defer func() {
		if p := recover(); p != nil {
			out, err = "", errors.New("extract: unreadable PDF")
		}
	}()
	doc, err := pdf.NewReader(r, size)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	for i := 1; i <= doc.NumPage() && b.Len() < MaxText*4; i++ {
		page := doc.Page(i)
		if page.V.IsNull() {
			continue
		}
		text, err := page.GetPlainText(nil)
		if err != nil {
			continue
		}
		b.WriteString(text)
		b.WriteString("\n")
	}
	return b.String(), nil
}

// zipText collects the character data of the XML parts a name filter picks,
// in name order, with a line break after each paragraph element.
func zipText(r io.ReaderAt, size int64, want func(string) bool, paragraph string) (string, error) {
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return "", err
	}
	files := make([]*zip.File, 0, 8)
	for _, f := range zr.File {
		if want(f.Name) && f.UncompressedSize64 < 50<<20 {
			files = append(files, f)
		}
	}
	sort.Slice(files, func(i, j int) bool { return naturalLess(files[i].Name, files[j].Name) })
	var b strings.Builder
	for _, f := range files {
		rc, err := f.Open()
		if err != nil {
			continue
		}
		dec := xml.NewDecoder(io.LimitReader(rc, 50<<20))
		for b.Len() < MaxText*4 {
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
	}
	return b.String(), nil
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
