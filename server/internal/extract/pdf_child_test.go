// SPDX-License-Identifier: AGPL-3.0-only

package extract

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// The test binary stands in for the server's: started with the child's
// subcommand, it reads a PDF the way the server's child does.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == ChildCommand {
		if err := ChildMain(os.Stdin, os.Stdout); err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// isolated makes PDFs be read by a child process of the test binary.
func isolated(t *testing.T) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	prev := pdfChild
	IsolatePDF(exe, ChildCommand)
	t.Cleanup(func() { pdfChild = prev })
}

// xrefStreamPDF builds a PDF 1.5 of the objects 1, 2, ... (1 is the
// catalog) with a cross-reference stream; an object listed in compressed is
// not written but declared to be the index-th object of the object stream
// numbered stream ([2]int{stream, index}).
func xrefStreamPDF(compressed map[int][2]int, objs ...string) []byte {
	var b bytes.Buffer
	b.WriteString("%PDF-1.5\n")
	offsets := make([]int, len(objs))
	for i, o := range objs {
		if _, ok := compressed[i+1]; ok {
			continue
		}
		offsets[i] = b.Len()
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", i+1, o)
	}
	xrefNum := len(objs) + 1
	xref := b.Len()
	var rows bytes.Buffer
	row := func(typ byte, f2 int, f3 int) {
		rows.Write([]byte{typ, byte(f2 >> 24), byte(f2 >> 16), byte(f2 >> 8), byte(f2), byte(f3 >> 8), byte(f3)})
	}
	row(0, 0, 65535)
	for i := range objs {
		if c, ok := compressed[i+1]; ok {
			row(2, c[0], c[1])
		} else {
			row(1, offsets[i], 0)
		}
	}
	row(1, xref, 0)
	fmt.Fprintf(&b, "%d 0 obj\n<< /Type /XRef /Size %d /W [1 4 2] /Root 1 0 R /Length %d >>\nstream\n", xrefNum, xrefNum+1, rows.Len())
	b.Write(rows.Bytes())
	fmt.Fprintf(&b, "\nendstream\nendobj\nstartxref\n%d\n%%%%EOF\n", xref)
	return b.Bytes()
}

// PDFs on which the PDF library itself never returns: the child that reads
// them is stopped and they have no text, while the server goes on.
var (
	// The page tree is object 2, compressed in object stream 2: resolving
	// it resolves itself until the stack overflows (a fatal error).
	selfStreamPDF = xrefStreamPDF(map[int][2]int{2: {2, 0}},
		"<< /Type /Catalog /Pages 2 0 R >>",
		"",
	)
	// The page tree is object 2 in object stream 3, which does not hold
	// it and extends itself: searching for it never ends.
	extendsCyclePDF = xrefStreamPDF(map[int][2]int{2: {3, 0}},
		"<< /Type /Catalog /Pages 2 0 R >>",
		"",
		"<< /Type /ObjStm /N 1 /First 4 /Extends 3 0 R /Length 9 >>\nstream\n9 0 null\nendstream",
	)
)

func TestPDFChildSurvivesLibraryFailures(t *testing.T) {
	isolated(t)
	for name, data := range map[string][]byte{"self-referencing object stream": selfStreamPDF, "object stream extends cycle": extendsCyclePDF} {
		prevTime := childTime
		childTime = 5 * time.Second
		start := time.Now()
		text, err := Text(context.Background(), bytes.NewReader(data), int64(len(data)), "application/pdf", "evil.pdf")
		childTime = prevTime
		if text != "" || err == nil {
			t.Errorf("%s: text = %q, err = %v", name, text, err)
		}
		if d := time.Since(start); d > 15*time.Second {
			t.Errorf("%s: took %v", name, d)
		}
		t.Logf("%s: %v in %v", name, err, time.Since(start).Round(time.Millisecond))
	}
}

// A good PDF reads the same in the child as in the server's process, also
// with a page the bounds skip (the child's limits leave room for them).
func TestPDFChildReadsText(t *testing.T) {
	bomb := "flate:BT /F1 12 Tf " + strings.Repeat("1 ", 32<<20) + "ET"
	data := pdfOf("", "BT /F1 12 Tf (first page) Tj ET", bomb, "BT /F1 12 Tf (second   page) Tj ET")
	direct, err := Text(context.Background(), bytes.NewReader(data), int64(len(data)), "application/pdf", "a.pdf")
	if err != nil {
		t.Fatal(err)
	}
	isolated(t)
	text, err := Text(context.Background(), bytes.NewReader(data), int64(len(data)), "application/pdf", "a.pdf")
	if err != nil || text != direct || !strings.Contains(text, "second page") {
		t.Errorf("text = %q (in process %q), %v", text, direct, err)
	}
}

// Without a program to start, PDFs are not read at all.
func TestPDFChildMissing(t *testing.T) {
	prev := pdfChild
	t.Cleanup(func() { pdfChild = prev })
	IsolatePDF("")
	data := pdfOf("", "BT /F1 12 Tf (page) Tj ET")
	if _, err := Text(context.Background(), bytes.NewReader(data), int64(len(data)), "application/pdf", "a.pdf"); !errors.Is(err, ErrUnsupported) {
		t.Errorf("err = %v", err)
	}
}
