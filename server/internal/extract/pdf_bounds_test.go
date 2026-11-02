// SPDX-License-Identifier: AGPL-3.0-only

package extract

import (
	"bytes"
	"compress/zlib"
	"context"
	"fmt"
	"runtime"
	"strings"
	"testing"
	"time"
)

// pdfOf builds a PDF with one page per content stream; a stream starting
// with "flate:" is stored FlateDecode-compressed, and cmap (when set) is the
// ToUnicode map of the font F1.
func pdfOf(cmap string, contents ...string) []byte {
	n := len(contents)
	// 1 catalog, 2 pages, 3 font, 4 cmap, then page i at 5+2i, content at 6+2i.
	kids := make([]string, n)
	for i := range n {
		kids[i] = fmt.Sprintf("%d 0 R", 5+2*i)
	}
	font := "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
	if cmap != "" {
		font = "<< /Type /Font /Subtype /Type0 /BaseFont /X /ToUnicode 4 0 R >>"
	}
	objs := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), n),
		font,
		fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(cmap), cmap),
	}
	for i, c := range contents {
		objs = append(objs, fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents %d 0 R /Resources << /Font << /F1 3 0 R >> >> >>", 6+2*i))
		if body, ok := strings.CutPrefix(c, "flate:"); ok {
			var z bytes.Buffer
			w := zlib.NewWriter(&z)
			_, _ = w.Write([]byte(body))
			_ = w.Close()
			objs = append(objs, fmt.Sprintf("<< /Length %d /Filter /FlateDecode >>\nstream\n%s\nendstream", z.Len(), z.String()))
		} else {
			objs = append(objs, fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(c), c))
		}
	}
	return rawPDF(objs...)
}

// rawPDF builds a PDF of the objects 1, 2, ... (1 is the catalog).
func rawPDF(objs ...string) []byte {
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

// A small PDF whose page inflates to 64 MiB is skipped with bounded memory
// and time; the other pages are still read.
func TestPDFBombIsBounded(t *testing.T) {
	bomb := "flate:BT /F1 12 Tf " + strings.Repeat("1 ", 32<<20) + "ET"
	data := pdfOf("", "BT /F1 12 Tf (first page) Tj ET", bomb, "BT /F1 12 Tf (last page) Tj ET")
	if len(data) > MaxSize {
		t.Fatalf("test PDF is %d bytes", len(data))
	}
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	start := time.Now()
	text, err := Text(context.Background(), bytes.NewReader(data), int64(len(data)), "application/pdf", "bomb.pdf")
	runtime.ReadMemStats(&after)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "first page") || !strings.Contains(text, "last page") {
		t.Errorf("text = %q", text)
	}
	if alloc := after.TotalAlloc - before.TotalAlloc; alloc > 64<<20 {
		t.Errorf("allocated %d MiB", alloc>>20)
	}
	if d := time.Since(start); d > 20*time.Second {
		t.Errorf("took %v", d)
	}
}

// Fonts' ToUnicode maps are applied (read once per font).
func TestPDFToUnicode(t *testing.T) {
	cmap := "/CIDInit /ProcSet findresource begin 12 dict begin begincmap " +
		"1 begincodespacerange <00> <FF> endcodespacerange " +
		"1 beginbfchar <41> <005A> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end"
	data := pdfOf(cmap, "BT /F1 12 Tf (AAA) Tj /F1 10 Tf [(A) -20 (A)] TJ ET")
	text, err := Text(context.Background(), bytes.NewReader(data), int64(len(data)), "application/pdf", "c.pdf")
	if err != nil || text != "ZZZZZ" {
		t.Errorf("text = %q, %v", text, err)
	}
}

// A page tree with a cycle (a node among its own kids, or pages that are
// each other's parents) ends within the time the caller gives, with the
// text of the pages that are there.
func TestPDFPageTreeCycles(t *testing.T) {
	content := "BT /F1 12 Tf (cycle page) Tj ET"
	stream := fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(content), content)
	for name, data := range map[string][]byte{
		"kids": rawPDF(
			"<< /Type /Catalog /Pages 2 0 R >>",
			"<< /Type /Pages /Kids [2 0 R] /Count 1 >>",
		),
		"kids with a page": rawPDF(
			"<< /Type /Catalog /Pages 2 0 R >>",
			"<< /Type /Pages /Kids [3 0 R 2 0 R] /Count 2 >>",
			"<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << >> >>",
			stream,
		),
		"parents": rawPDF(
			"<< /Type /Catalog /Pages 2 0 R >>",
			"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
			"<< /Type /Page /Parent 5 0 R /Contents 4 0 R >>",
			stream,
			"<< /Type /Pages /Parent 6 0 R >>",
			"<< /Type /Pages /Parent 5 0 R >>",
		),
	} {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		done := make(chan string, 1)
		go func() {
			text, _ := Text(ctx, bytes.NewReader(data), int64(len(data)), "application/pdf", "cycle.pdf")
			done <- text
		}()
		select {
		case text := <-done:
			if name != "kids" && !strings.Contains(text, "cycle page") {
				t.Errorf("%s: text = %q", name, text)
			}
		case <-time.After(6 * time.Second):
			t.Errorf("%s: still reading after 6 s", name)
		}
		cancel()
	}
}
