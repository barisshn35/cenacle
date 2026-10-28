// SPDX-License-Identifier: AGPL-3.0-only

package extract

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func zipOf(t *testing.T, parts map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for name, body := range parts {
		f, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = f.Write([]byte(body))
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// minimalPDF is a one-page PDF with a line of text, with a correct xref table.
func minimalPDF(text string) []byte {
	stream := fmt.Sprintf("BT /F1 12 Tf 72 720 Td (%s) Tj ET", text)
	objs := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(stream), stream),
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	}
	var b bytes.Buffer
	b.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(objs))
	for i, o := range objs {
		offsets[i] = b.Len()
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", i+1, o)
	}
	xref := b.Len()
	fmt.Fprintf(&b, "xref\n0 %d\n0000000000 65535 f \n", len(objs)+1)
	for _, off := range offsets {
		fmt.Fprintf(&b, "%010d 00000 n \n", off)
	}
	fmt.Fprintf(&b, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objs)+1, xref)
	return b.Bytes()
}

func TestText(t *testing.T) {
	cases := []struct {
		name, contentType string
		data              []byte
		want              []string
	}{
		{"notes.md", "text/markdown", []byte("# Plan\n\n\nQuarterly   report"), []string{"# Plan\nQuarterly report"}},
		{"report.pdf", "application/pdf", minimalPDF("Quarterly revenue grew"), []string{"Quarterly revenue grew"}},
		{"memo.docx", "", zipOf(t, map[string]string{
			"word/document.xml": `<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Gizli</w:t></w:r><w:r><w:t> proje</w:t></w:r></w:p><w:p><w:r><w:t>Takvim</w:t></w:r></w:p></w:body></w:document>`,
			"word/styles.xml":   `<w:styles xmlns:w="w"><w:t>not this</w:t></w:styles>`,
		}), []string{"Gizli proje", "Takvim"}},
		{"budget.xlsx", "", zipOf(t, map[string]string{
			"xl/sharedStrings.xml": `<sst><si><t>Revenue</t></si><si><t>Costs</t></si></sst>`,
		}), []string{"Revenue", "Costs"}},
		{"deck.pptx", "", zipOf(t, map[string]string{
			"ppt/slides/slide1.xml":  `<p:sld xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>`,
			"ppt/slides/slide10.xml": `<p:sld xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>Tenth</a:t></a:r></a:p></p:sld>`,
			"ppt/slides/slide2.xml":  `<p:sld xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>`,
		}), []string{"First\nSecond\nTenth"}},
		{"letter.odt", "application/vnd.oasis.opendocument.text", zipOf(t, map[string]string{
			"content.xml": `<office:document-content xmlns:office="o" xmlns:text="t"><office:body><text:p>Sayın yetkili</text:p></office:body></office:document-content>`,
		}), []string{"Sayın yetkili"}},
	}
	for _, c := range cases {
		got, err := Text(context.Background(), bytes.NewReader(c.data), int64(len(c.data)), c.contentType, c.name)
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		for _, w := range c.want {
			if !strings.Contains(got, w) {
				t.Errorf("%s: %q lacks %q", c.name, got, w)
			}
		}
		if strings.Contains(got, "not this") {
			t.Errorf("%s: read a part it should not: %q", c.name, got)
		}
	}
	if _, err := Text(context.Background(), bytes.NewReader([]byte("x")), 1, "image/png", "a.png"); !errors.Is(err, ErrUnsupported) {
		t.Errorf("png = %v", err)
	}
	if _, err := Text(context.Background(), bytes.NewReader([]byte("%PDF-1.4 broken")), 15, "application/pdf", "b.pdf"); err == nil {
		t.Error("a broken PDF gave no error")
	}
}

// emptyMarkup is n bytes of elements without text: it deflates about a
// thousandfold and never reaches the text bound.
func emptyMarkup(n int) string {
	return "<w:hdr>" + strings.Repeat("<a/>", n/4) + "</w:hdr>"
}

// The parts of one file share a budget of inflated bytes: many small,
// highly compressed parts of empty markup are not read to the end.
func TestZipPartsShareABudget(t *testing.T) {
	old := maxZipContent
	t.Cleanup(func() { maxZipContent = old })
	maxZipContent = 2 << 20

	parts := map[string]string{"word/header1.xml": "<w:p>EARLY</w:p>"}
	for i := 2; i <= 20; i++ {
		parts[fmt.Sprintf("word/header%d.xml", i)] = emptyMarkup(1 << 20)
	}
	parts["word/header21.xml"] = "<w:p>LATE</w:p>"
	data := zipOf(t, parts)
	got, err := Text(context.Background(), bytes.NewReader(data), int64(len(data)), "", "a.docx")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "EARLY") || strings.Contains(got, "LATE") {
		t.Errorf("text = %q, want the first part only", got)
	}
}

func TestZipPartsAreCounted(t *testing.T) {
	old := maxZipParts
	t.Cleanup(func() { maxZipParts = old })
	maxZipParts = 2

	data := zipOf(t, map[string]string{
		"ppt/slides/slide1.xml": "<p>one</p>", "ppt/slides/slide2.xml": "<p>two</p>", "ppt/slides/slide3.xml": "<p>three</p>",
	})
	got, err := Text(context.Background(), bytes.NewReader(data), int64(len(data)), "", "a.pptx")
	if err != nil || got != "one\ntwo" {
		t.Errorf("text = %q, %v", got, err)
	}
}

// Reading stops when the job gives up, and when the file's time is spent.
func TestZipTextStops(t *testing.T) {
	data := zipOf(t, map[string]string{"word/document.xml": "<w:p>words</w:p>"})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got, err := Text(ctx, bytes.NewReader(data), int64(len(data)), "", "a.docx"); err != nil || got != "" {
		t.Errorf("cancelled: %q, %v", got, err)
	}

	old := zipTime
	t.Cleanup(func() { zipTime = old })
	zipTime = 50 * time.Millisecond
	parts := map[string]string{}
	for i := 1; i <= 40; i++ {
		parts[fmt.Sprintf("word/header%d.xml", i)] = emptyMarkup(1 << 20)
	}
	data = zipOf(t, parts)
	start := time.Now()
	if _, err := Text(context.Background(), bytes.NewReader(data), int64(len(data)), "", "b.docx"); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("reading took %v past its time", elapsed)
	}
}
