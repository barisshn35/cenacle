// SPDX-License-Identifier: AGPL-3.0-only

package extract

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"runtime/debug"
	"strings"
	"time"
	"unicode/utf8"
)

// The PDF library can loop forever or recurse until the stack overflows (a
// fatal error no recover catches) on a crafted file, beyond what the bounds
// in pdfText can see. The server therefore reads PDFs in a child process:
// itself, started with a hidden subcommand that calls ChildMain. The child
// gets the file on stdin, an empty environment and no other descriptors,
// limits itself (address space, CPU time) at start, and is killed when it
// runs out of wall-clock time; whatever happens to it, the file only has no
// text.

// ChildCommand is the hidden subcommand of the server that reads a PDF
// (cenacle-server extract-pdf).
const ChildCommand = "extract-pdf"

// ErrReaderFailed: the child reading a PDF crashed, was stopped at a limit
// or ran out of time.
var ErrReaderFailed = errors.New("extract: PDF reader failed")

// Bounds of the child. Its wall-clock time covers its own budget (pdfTime)
// and its start; its CPU time allows for the runtime's own threads.
const (
	maxChildren    = 2        // children at once per server
	childMemory    = 1 << 30  // bytes of memory the child may add
	childCPU       = 60       // seconds of CPU time
	childStack     = 64 << 20 // bytes of one goroutine's stack
	maxChildOutput = MaxText*4 + 4096
	maxChildStderr = 4 << 10
)

// childTime is the child's wall-clock time (a variable so tests can lower it).
var childTime = pdfTime + 15*time.Second

// pdfChild is how PDFs are read: in this process (on, false: tests and
// tools), by the program exe started with args, or not at all (exe empty).
var pdfChild struct {
	on   bool
	exe  string
	args []string
}

var children = make(chan struct{}, maxChildren)

// IsolatePDF makes PDFs be read by a child process: the program exe started
// with args, which must run ChildMain (the server passes its own executable
// and ChildCommand). An empty exe means PDFs are not read. Call it once at
// start-up, before files are read.
func IsolatePDF(exe string, args ...string) {
	pdfChild.on, pdfChild.exe, pdfChild.args = true, exe, args
}

// readPDF reads a PDF's text in this process or in a child, as configured.
func readPDF(ctx context.Context, r io.ReaderAt, size int64) (string, error) {
	if !pdfChild.on {
		return pdfText(ctx, r, size)
	}
	if pdfChild.exe == "" {
		return "", ErrUnsupported
	}
	select {
	case children <- struct{}{}:
		defer func() { <-children }()
	case <-ctx.Done():
		return "", ctx.Err()
	}
	ctx, cancel := context.WithTimeout(ctx, childTime)
	defer cancel()
	cmd := exec.CommandContext(ctx, pdfChild.exe, pdfChild.args...) //nolint:gosec // the server's own executable
	cmd.Env = []string{}
	cmd.Stdin = io.NewSectionReader(r, 0, size)
	out := &capped{max: maxChildOutput}
	stderr := &capped{max: maxChildStderr}
	cmd.Stdout, cmd.Stderr = out, stderr
	cmd.SysProcAttr = childAttr()
	cmd.WaitDelay = 2 * time.Second
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return "", fmt.Errorf("%w: out of time", ErrReaderFailed)
		}
		msg, _, _ := strings.Cut(strings.TrimSpace(stderr.b.String()), "\n")
		return "", fmt.Errorf("%w: %w: %s", ErrReaderFailed, err, msg)
	}
	b := out.b.Bytes()
	if !utf8.Valid(b) {
		b = bytes.ToValidUTF8(b, nil)
	}
	return string(b), nil
}

// ChildMain reads a PDF on in and writes its text to out: the child's side
// of IsolatePDF. It limits its own process first.
func ChildMain(in io.Reader, out io.Writer) error {
	if err := limitChild(childMemory, childCPU); err != nil {
		return err
	}
	debug.SetMaxStack(childStack)
	data, err := io.ReadAll(io.LimitReader(in, MaxSize+1))
	if err != nil {
		return err
	}
	if len(data) > MaxSize {
		return ErrUnsupported
	}
	ctx, cancel := context.WithTimeout(context.Background(), pdfTime)
	defer cancel()
	text, err := pdfText(ctx, bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return err
	}
	if len(text) > maxChildOutput {
		text = text[:maxChildOutput]
	}
	_, err = io.WriteString(out, text)
	return err
}

// capped keeps the first max bytes written to it and drops the rest, so the
// child never blocks on a full pipe.
type capped struct {
	b   bytes.Buffer
	max int
}

func (c *capped) Write(p []byte) (int, error) {
	if room := c.max - c.b.Len(); room > 0 {
		c.b.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}
